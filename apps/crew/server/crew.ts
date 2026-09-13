/**
 * The crew: agents that exist on a chain, spend from a shared wallet, and run.
 *
 * Three things make an agent here, and only the third is ordinary:
 *
 *   1. A name, minted under `edgerouter.eth`. Not a label in a database — a
 *      record on Sepolia that resolves to an address, which is what lets the
 *      authority ask "does this thing still exist" before signing anything.
 *   2. An allowance, issued by the authority as a capability. The agent holds a
 *      bearer string and no key, so its limit is enforced by the side holding
 *      the money rather than by its own good behaviour.
 *   3. A loop, which is pi's, not ours.
 *
 * Revocation is where the three meet: clearing the name's address record stops
 * an agent mid-task, because the guard rechecks the name before the next
 * payment and the authority then refuses to sign. The agent is not asked to
 * stop. It simply cannot buy anything more.
 */
import { randomUUID } from 'node:crypto';
import {
  createAuthority,
  authorityHandler,
  connectAuthority,
  fetchTabTerms,
  payAndFetch,
  serveAuthority,
  formatAmount,
  type Authority,
  type Connection,
  type ServedAuthority,
  type TabShortfall,
  type TabTerms,
} from '../../../packages/sdk/src/index';
import {
  createEnsClient,
  ensNameGuard,
  ensureAgentName,
  openEnsSigner,
  revokeAgentName,
  registryOf,
  permissionsOf,
  setProfile,
  setText,
  NONE,
  RECORD,
  ROOT_NAME,
} from '../../../packages/ens/src/index';
import { load, save, type Agent, type Crew } from './store';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, knownOnly } from './permissions';
import {
  describeGrant,
  newProjectId,
  workspacePathFor,
  type Project,
  type ProjectMode,
} from './projects';
import type { Root } from './tools';
import { emit } from './events';
import { openWallet, type OpenWallet } from './wallet';

const AUTHORITY_PORT = Number(process.env.CREW_AUTHORITY_PORT ?? 8792);
const AUTHORITY_URL = `http://127.0.0.1:${AUTHORITY_PORT}`;

export type Runtime = {
  wallet: OpenWallet;
  authority: Authority;
  gate: string;
  /** Live connections, one per agent. Not persisted — rebuilt from the tree. */
  connections: Map<string, Connection>;
  crew: Crew;
  /** Whether names can be minted. False when the root name owns no registry. */
  naming: boolean;
  server: ServedAuthority;
  /**
   * The gate's tab terms on this network, or null when it keeps none.
   *
   * Null is an ordinary answer, not a failure: agents then pay per call, as
   * they did before tabs existed.
   */
  tab: TabTerms | null;
  /** Tops the gate tab up from the wallet. One at a time, however many agents ask. */
  topUp(shortfall: TabShortfall): Promise<boolean>;
  stop(): Promise<void>;
};

/*
  What a top-up adds when the shortfall is smaller. A tenth of a dollar covers
  ten calls at the largest reserve, so a crew working steadily tops up every few
  minutes rather than before every call — and leaves little at the gate if it
  stops.
*/
const TOPUP_MINOR = 100_000n;

/**
 * The authority, as every place that builds one needs it built.
 *
 * Two call sites — boot and a funding rebuild — and the second once forgot the
 * name guard it was given at boot. A tab origin is one more thing that has to
 * match between them, so they share this rather than each spelling it out.
 */
const authorityFor = (wallet: OpenWallet, gate: string, tab: TabTerms | null): Promise<Authority> =>
  createAuthority({
    signer: wallet.signer,
    secret: randomUUID(),
    /*
      Zero for a wallet that cannot pay yet, rather than a refusal to start.
      An authority funded with nothing hands out nothing, which is the correct
      behaviour for a crew with no money — and it lets the app come up and say
      so instead of exiting before it serves a page.
    */
    fundedMinor: wallet.spendableMinor,
    /*
      Checked before every signature, which is what lets a name revoked on
      chain stop an agent that is already running. Nodes that are not names
      pass through untouched — the root is called `root` and always will be.
    */
    names: ensNameGuard({ suffix: '.eth' }),
    /*
      The root holds every permission this build defines, because it is the
      ceiling agents are minted beneath rather than an actor in its own right.
      Nothing runs as the root — an agent gets what its own grant names,
      intersected with this.
    */
    scope: ALL_PERMISSIONS,
    /*
      The one gate this crew keeps a tab with. The authority both signs vouchers
      for it and asks it what they cost, so it is named here from configuration
      and never taken from an agent's request.
    */
    ...(tab ? { tabOrigins: [new URL(gate).origin] } : {}),
  });

export const publish = (runtime: Runtime): void => {
  save(runtime.crew);
  emit({ type: 'crew', agents: runtime.crew.agents });
};

/**
 * Gives an agent a live allowance, sized to what it has left rather than what
 * it started with.
 *
 * The distinction is the whole reason spend is persisted. An agent that has
 * spent 1.2 of its 2.0 must come back from a restart with 0.8 — otherwise
 * restarting is how you refill a budget, and a limit you can reset is not a
 * limit.
 */
const attach = async (runtime: Runtime, agent: Agent): Promise<Connection> => {
  const remaining = BigInt(agent.budgetMinor) - BigInt(agent.spentMinor);
  if (remaining <= 0n) {
    agent.status = 'broke';
    throw new Error('its budget is spent');
  }

  /*
    What the chain says this agent may ever do, intersected with what the crew
    file asks for.

    This is the read that makes `er.permissions` a record rather than a
    decoration. Striking a permission from the name takes it away from the next
    capability minted, from a block explorer, without touching this process —
    which is on-chain revocation of scope rather than merely of existence.

    Its limit is worth stating plainly: a capability already issued keeps what
    it was given, so a scope revoked on chain takes effect when the agent is
    next attached, not mid-task. The immediate lever is still the address
    record; clearing that stops the agent's next payment outright, and it is
    what `fire` uses.

    A name with no record is unconstrained from here. An RPC that failed reads
    the same way, deliberately — see `permissionsOf` — because an outage is not
    a statement about permissions, and the alternative is every agent in the
    roster losing its tools because a public endpoint was slow.
  */
  const asked = knownOnly(agent.permissions ?? DEFAULT_PERMISSIONS);

  /*
    Directory grants ride in the capability as opaque ids, never as paths.

    `project:prj_7f3a:write` says nothing about the machine to anything holding
    it, and the id means nothing without the runtime's own record — which is the
    point. They are appended after the coarse permissions are intersected,
    because they are not coarse permissions: what reaches the chain is
    `files:host` alone, and it never says which directory.

    A grant whose project no longer exists is dropped rather than carried. A
    capability naming a project nobody can resolve is a permission that reads as
    real and is not.
  */
  const grants = (agent.grants ?? [])
    .filter((grant) => runtime.crew.projects?.some((project) => project.id === grant.projectId))
    .map((grant) => `project:${grant.projectId}:${grant.mode}`);
  const published = agent.name ? await permissionsOf(createEnsClient(), agent.name) : null;
  const scope = published === null ? asked : asked.filter((permission) => published.includes(permission));

  if (published !== null && scope.length < asked.length) {
    const struck = asked.filter((permission) => !scope.includes(permission));
    emit({
      type: 'log',
      text: `${agent.name} does not permit ${struck.join(', ')} on chain; withheld`,
    });
  }

  const granted = await runtime.authority.mint({
    parent: runtime.authority.rootToken,
    /*
      The node is the ENS name whenever there is one, and that is the mechanism
      rather than a nicety: the guard checks each node against ENS, so a node
      named for the agent's name is a node that stops working when the name
      does. An agent whose name failed to mint falls back to its label, and
      pays the price of being revocable only locally.
    */
    child: agent.name ?? agent.label,
    amountMinor: remaining,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    /*
      Permissions are minted with the allowance rather than stored beside it, so
      the thing an agent presents is the thing that says what it may do. The
      authority intersects this with what the parent holds, so a request for
      more than the root was given comes back smaller rather than refused.

      Unknown names are dropped here rather than sent: a token asserting a
      permission nothing in this build can check is a token that reads as more
      powerful than it is.
    */
    scope: [...scope, ...(scope.includes('files:host') ? grants : [])],
  });

  const connection = await connectAuthority({
    url: AUTHORITY_URL,
    capability: granted.capability,
    resourceUrl: runtime.gate,
  });

  agent.capability = granted.capability;
  agent.account = connection.account;
  runtime.connections.set(agent.id, connection);
  return connection;
};

/**
 * Brings up the wallet, the authority, and every agent that already exists.
 *
 * The authority is funded with what the wallet can actually spend, not a number
 * from a config file. A tree that believes it holds more than the wallet does
 * hands out allowances that fail at the moment of payment, which is the worst
 * possible place to find out.
 */
export const boot = async (options: { gate: string; network: string }): Promise<Runtime> => {
  const wallet = await openWallet(options.network, options.gate);
  const crew = load();

  /*
    Asked once, at boot. A gate that keeps no tab — or cannot be reached right
    now — leaves the crew paying per call, which still works; it is not a
    reason to refuse to start.
  */
  const tab = await fetchTabTerms(options.gate, options.network).catch(() => null);
  if (tab) emit({ type: 'log', text: `paying from a tab at ${new URL(options.gate).host}` });

  const authority = await authorityFor(wallet, options.gate, tab);

  /*
    Whether names can be minted at all, asked once rather than assumed. The root
    name owns a registry only if it was deployed with one, and an install
    pointing at a chain where it was not should lose naming and keep spending
    rather than refuse to start.
  */
  let naming = false;
  try {
    const ens = openEnsSigner();
    naming = (await registryOf(ens.public, ROOT_NAME)) !== null;
  } catch {
    naming = false;
  }

  /*
    One top-up in flight, shared. Every agent on a crew hits an empty tab at
    the same moment — they all spend from it — and each one topping up on its
    own would move several times what anyone needed.
  */
  let topping: Promise<boolean> | null = null;

  /*
    Vouchers whose calls ended without a receipt — a stream cut off, a task
    stopped — still hold budget until somebody asks the gate what they cost.
    The agent that made them may never ask, so the runtime does.
  */
  const sweeper = setInterval(() => {
    void runtime.authority.sweepVouchers().catch(() => undefined);
  }, 60_000);

  const runtime: Runtime = {
    wallet,
    authority,
    gate: options.gate,
    connections: new Map(),
    crew,
    naming,
    server: undefined as unknown as ServedAuthority,
    tab,
    topUp(shortfall) {
      if (topping) return topping;
      topping = (async () => {
        const terms = runtime.tab;
        if (!terms) return false;
        const wanted = shortfall.reserveMinor - shortfall.balanceMinor;
        const amount = wanted > TOPUP_MINOR ? wanted : TOPUP_MINOR;
        try {
          /*
            Paid by the wallet itself, not through the authority. A top-up is
            not any agent's spending — the money stays the crew's, only its
            location changes — so it is charged to no node. What each agent
            spends from the tab is charged to that agent, voucher by voucher.
          */
          const url = new URL('/v1/tab/topup', runtime.gate);
          url.searchParams.set('amount', amount.toString());
          const result = await payAndFetch(url.toString(), {
            signer: runtime.wallet.signer,
            network: terms.network,
            maxAmount: amount,
            init: { method: 'POST' },
          });
          if (!result.response.ok) {
            const detail = await result.response.text().catch(() => '');
            emit({ type: 'log', text: `could not top up the gate tab (${result.response.status}): ${detail.slice(0, 160)}` });
            return false;
          }
          emit({ type: 'log', text: `topped up the gate tab by ${formatAmount(terms.network, amount)}` });
          return true;
        } catch (error) {
          emit({ type: 'log', text: `could not top up the gate tab: ${(error as Error).message}` });
          return false;
        }
      })().finally(() => {
        topping = null;
      });
      return topping;
    },
    async stop() {
      clearInterval(sweeper);
      await runtime.server.close();
    },
  };

  /*
    Served through a lambda rather than a handler bound to this authority.

    Money arriving has to be able to rebuild the tree — the root's balance is
    fixed when the authority is created, so a deposit cannot raise it — and a
    handler that captured the authority at boot would keep serving the old one
    after the rebuild, quietly refusing capabilities that were just re-issued.
  */
  runtime.server = await serveAuthority((request) => authorityHandler(runtime.authority)(request), {
    port: AUTHORITY_PORT,
  });

  /*
    Agents from previous runs are reconnected, not re-created. Their names are
    still on chain and their spend is still on file, but the authority's tree
    lives in memory and was rebuilt this boot — so the nodes their old
    capabilities named are gone, and each one is re-minted at its remaining
    balance.
  */
  for (const agent of crew.agents) {
    if (agent.status === 'revoked') continue;
    /*
      An agent belongs to the network it was hired on, and switching networks
      must not quietly re-price it.

      A budget is a bigint of the smallest unit, and the smallest unit is not
      the same size twice: `15000000` is 0.15 hbar and also 15 USDC. Attaching a
      Hedera agent against an Arc wallet would either commit fifteen dollars to
      something funded with eight cents, or fail with a message about budgets
      that says nothing about the actual problem. So it is skipped, and left
      exactly as it was — its name, its spend and its history are all still
      true, they are simply true about another chain.
    */
    if (agent.network !== wallet.network) continue;
    try {
      await attach(runtime, agent);
      if (agent.status !== 'broke') agent.status = 'idle';
    } catch (error) {
      emit({ type: 'log', text: `${agent.label} could not be reconnected: ${(error as Error).message}` });
    }
  }

  publish(runtime);
  return runtime;
};

/**
 * Hires an agent: a name, a budget, and nothing else.
 *
 * The name is minted before the allowance so the allowance can be issued
 * against it. An agent whose name fails to mint still gets a budget under its
 * plain label — it can work, it just cannot be stopped by a registry write, and
 * the UI says which kind of agent it is looking at rather than implying both
 * are the same.
 */
export const hire = async (
  runtime: Runtime,
  params: {
    label: string;
    /** What a person calls it. Optional — an agent may just be its alias. */
    title?: string;
    brief: string;
    budgetMinor: bigint;
    model: string;
    /** Drawn in the browser — a sigil, or whatever the user pointed at. */
    avatar?: string;
    header?: string;
    /** What it may do. Omitted means the default set. */
    permissions?: string[];
    /** Directories it may reach, by project id. Needs `files:host` to matter. */
    grants?: { projectId: string; mode: ProjectMode }[];
  },
): Promise<Agent> => {
  const label = params.label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!label) throw new Error('an agent needs a name');
  if (runtime.crew.agents.some((existing) => existing.label === label && existing.status !== 'revoked')) {
    throw new Error(`there is already an agent called ${label}`);
  }
  if (params.budgetMinor <= 0n) throw new Error('an agent needs a budget');

  /*
    Budgets are checked against the wallet, in total, before anything is minted.

    The authority would refuse an over-commitment on its own, but only at the
    moment of payment — which would mean a roster of agents that all look funded
    and one of them failing mid-task for reasons the user cannot see. Refused
    here, while it is still a form with a number in it.
  */
  /*
    Only agents on this network, for the same reason `boot` skips the others: a
    budget is a bigint of the smallest unit, and `15000000` is 0.15 hbar and
    also 15 USDC. Summing across chains would price a Hedera crew in dollars and
    refuse every hire against a wallet that has plenty.
  */
  const promised = runtime.crew.agents
    .filter((existing) => existing.status !== 'revoked' && existing.network === runtime.wallet.network)
    .reduce((total, existing) => total + (BigInt(existing.budgetMinor) - BigInt(existing.spentMinor)), 0n);
  if (promised + params.budgetMinor > runtime.wallet.spendableMinor) {
    throw new Error(
      `the wallet can spend ${formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor)}, and ` +
        `${formatAmount(runtime.wallet.network, promised)} of that is already promised to other agents`,
    );
  }

  const agent: Agent = {
    id: randomUUID(),
    label,
    brief: params.brief,
    model: params.model,
    budgetMinor: params.budgetMinor.toString(),
    spentMinor: '0',
    network: runtime.wallet.network,
    createdAt: Date.now(),
    status: 'idle',
    tasks: [],
    permissions: knownOnly(params.permissions ?? DEFAULT_PERMISSIONS),
    ...(params.grants?.length ? { grants: params.grants } : {}),
    ...(params.title?.trim() ? { title: params.title.trim() } : {}),
    ...(params.avatar ? { avatar: params.avatar } : {}),
    ...(params.header ? { header: params.header } : {}),
  };

  if (runtime.naming) {
    emit({ type: 'log', text: `minting ${label}.${ROOT_NAME} …` });
    try {
      const ens = openEnsSigner();
      const named = await ensureAgentName(
        { public: ens.public, wallet: ens.wallet },
        {
          label,
          owner: ens.address,
          /*
            Leaf agents. One that can mint names beneath itself can hand out
            budgets beneath itself too, and nothing here asks for that yet — the
            tree supports it, the UI does not, and an allowance nobody can see
            is one nobody can revoke.
          */
          subdelegate: false,
          grantedMinor: params.budgetMinor,
          /*
            The coarse set, published as the name's outer bound. Coarse is the
            whole discipline here: `files:read` says this agent may read files,
            and nothing on chain ever says whose or which.
          */
          permissions: agent.permissions ?? DEFAULT_PERMISSIONS,
          /*
            The picture goes on chain in the same transaction as the name, under
            the conventional ENS keys — so the agent has a face in the ENS
            manager and anywhere else that resolves names, not only in this app.

            Carried by the mint rather than written after it, because there is
            no longer a reason for them to be two transactions. The caution this
            replaces — a separate write, so a failed picture could not cost the
            name — is kept where it belongs: `mintAgentName` retries without the
            profile when the profile is what fails, so the bad case is still an
            agent with a name and no face rather than no agent at all.
          */
          profile: {
            description: agent.brief,
            ...(agent.title ? { display: agent.title } : {}),
            ...(agent.avatar ? { avatar: agent.avatar } : {}),
            ...(agent.header ? { header: agent.header } : {}),
          },
        },
      );
      agent.name = named.name;
      agent.ensParentRegistry = named.parentRegistry;
      agent.ensResolver = named.resolver;

      if (!named.profileWritten) {
        emit({ type: 'log', text: `${named.name} was minted, but its profile did not reach the chain` });
      }
    } catch (error) {
      emit({ type: 'log', text: `${label} has no ENS name: ${(error as Error).message}` });
    }
  }

  runtime.crew.agents.push(agent);
  await attach(runtime, agent);
  publish(runtime);
  return agent;
};

/**
 * Changes an agent after it exists.
 *
 * Everything here is editable except the one thing that cannot be: the alias.
 * It is half the ENS name, the name is the node the authority charges, and the
 * guard checks that node before every signature — changing it would mean minting
 * a second name and abandoning the first, which is a different operation with a
 * different price, so it is not offered as an edit. The title is not the alias
 * and nothing is keyed on it, which is exactly why it can be changed freely: an
 * agent can be promoted without being re-hired.
 *
 * A budget change re-mints the allowance, because the tree holds an amount and
 * not a reference to this record. Lowering below what is already spent is
 * refused rather than clamped: it reads as "spend no more", and silently
 * turning it into "you have spent it all" would be a different instruction.
 */
export const update = async (
  runtime: Runtime,
  id: string,
  changes: {
    title?: string;
    brief?: string;
    model?: string;
    budgetMinor?: bigint;
    avatar?: string;
    header?: string;
    permissions?: string[];
    grants?: { projectId: string; mode: ProjectMode }[];
  },
): Promise<Agent> => {
  const agent = agentById(runtime, id);
  if (agent.status === 'revoked') throw new Error(`${agent.label} has been revoked`);

  if (changes.budgetMinor !== undefined && changes.budgetMinor !== BigInt(agent.budgetMinor)) {
    const spent = BigInt(agent.spentMinor);
    if (changes.budgetMinor < spent) {
      throw new Error(
        `${agent.label} has already spent ${formatAmount(agent.network, spent)}; a budget below that cannot be set`,
      );
    }

    const promised = runtime.crew.agents
      .filter(
        (other) =>
          other.id !== agent.id && other.status !== 'revoked' && other.network === runtime.wallet.network,
      )
      .reduce((total, other) => total + (BigInt(other.budgetMinor) - BigInt(other.spentMinor)), 0n);
    if (promised + (changes.budgetMinor - spent) > runtime.wallet.spendableMinor) {
      throw new Error(
        `the wallet can spend ${formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor)}, and ` +
          `${formatAmount(runtime.wallet.network, promised)} of that is already promised elsewhere`,
      );
    }

    agent.budgetMinor = changes.budgetMinor.toString();

    /*
      The old allowance is revoked before the new one is minted. Leaving it in
      place would mean an agent holding two capabilities and a limit that is the
      sum of them — which is the one thing a budget must never quietly become.
    */
    runtime.connections.delete(agent.id);
    try {
      runtime.authority.revoke({ token: runtime.authority.rootToken, node: agent.name ?? agent.label });
    } catch {
      // Not in the tree — nothing to withdraw before re-minting.
    }
    if (BigInt(agent.budgetMinor) > spent) {
      agent.status = agent.status === 'broke' ? 'idle' : agent.status;
      await attach(runtime, agent);
    } else {
      agent.status = 'broke';
    }
  }

  /*
    Permissions live in the capability, so changing them means issuing a new
    one. Same shape as a budget change and for the same reason: the tree holds
    a token, not a reference to this record, and editing the record alone would
    leave an agent whose file says one thing while the thing it presents at the
    gate says another.

    The old allowance is withdrawn first. Two live capabilities for one agent
    would mean it holds the union of their permissions, which is the one thing a
    narrowing must never quietly become.
  */
  if (changes.permissions !== undefined) {
    const wanted = knownOnly(changes.permissions);
    const current = agent.permissions ?? DEFAULT_PERMISSIONS;
    const changed =
      wanted.length !== current.length || wanted.some((permission) => !current.includes(permission));

    agent.permissions = wanted;

    /*
      The chain first, then the capability. `attach` reads the published set and
      intersects, so re-minting before the write would produce a capability
      narrowed by the *old* record — and widening a permission would appear not
      to work while narrowing appeared to work twice.
    */
    if (changed && agent.name && agent.ensResolver) {
      emit({ type: 'log', text: `publishing ${agent.name}'s permissions …` });
      try {
        const ens = openEnsSigner();
        await setText(
          { public: ens.public, wallet: ens.wallet },
          {
            resolver: agent.ensResolver as `0x${string}`,
            name: agent.name,
            key: RECORD.permissions,
            value: wanted.length === 0 ? NONE : [...wanted].sort().join(' '),
          },
        );
      } catch (error) {
        emit({
          type: 'log',
          text: `${agent.name} kept its published permissions: ${(error as Error).message}`,
        });
      }
    }

    if (changed && agent.status !== 'broke' && BigInt(agent.budgetMinor) > BigInt(agent.spentMinor)) {
      runtime.connections.delete(agent.id);
      try {
        runtime.authority.revoke({ token: runtime.authority.rootToken, node: agent.name ?? agent.label });
      } catch {
        // Not in the tree — nothing to withdraw before re-minting.
      }
      await attach(runtime, agent);
    }
  }

  /*
    Directory grants, applied before the capability is re-minted below for the
    same reason permissions are: the token carries them, so changing the record
    without re-issuing would leave an agent whose file and whose capability
    disagree about what it can open.
  */
  if (changes.grants !== undefined) {
    const known = changes.grants.filter((grant) =>
      runtime.crew.projects?.some((project) => project.id === grant.projectId),
    );
    const before = JSON.stringify(agent.grants ?? []);
    agent.grants = known;

    // A revoked agent never reaches here — `update` refuses one at the top.
    if (JSON.stringify(known) !== before && BigInt(agent.budgetMinor) > BigInt(agent.spentMinor)) {
      runtime.connections.delete(agent.id);
      try {
        runtime.authority.revoke({ token: runtime.authority.rootToken, node: agent.name ?? agent.label });
      } catch {
        // Not in the tree; nothing to withdraw.
      }
      await attach(runtime, agent);
    }
  }

  if (changes.title !== undefined) agent.title = changes.title.trim();
  if (changes.brief !== undefined) agent.brief = changes.brief;
  if (changes.model !== undefined) agent.model = changes.model;
  if (changes.avatar !== undefined) agent.avatar = changes.avatar;
  if (changes.header !== undefined) agent.header = changes.header;

  /*
    Only the keys that changed are written, and only when there is a name to
    write them to. Each is a transaction, so rewriting an untouched avatar
    because a description changed would be charging the user for nothing.
  */
  const profile = {
    ...(changes.title !== undefined ? { display: changes.title.trim() } : {}),
    ...(changes.brief !== undefined ? { description: changes.brief } : {}),
    ...(changes.avatar !== undefined ? { avatar: changes.avatar } : {}),
    ...(changes.header !== undefined ? { header: changes.header } : {}),
  };

  if (agent.name && agent.ensResolver && Object.keys(profile).length > 0) {
    emit({ type: 'log', text: `updating ${agent.name} …` });
    try {
      const ens = openEnsSigner();
      await setProfile(
        { public: ens.public, wallet: ens.wallet },
        { resolver: agent.ensResolver as `0x${string}`, name: agent.name, ...profile },
      );
    } catch (error) {
      emit({ type: 'log', text: `${agent.name} kept its old records: ${(error as Error).message}` });
    }
  }

  publish(runtime);
  return agent;
};

/**
 * Fires an agent, on chain.
 *
 * Two revocations, and both are needed. The authority's is immediate and local:
 * the node is deleted, so the capability names nothing and the next signature
 * is refused. The ENS one is the durable half — the address record is cleared,
 * so any authority anywhere, including one started tomorrow from the same
 * wallet, refuses it too.
 */
export const fire = async (runtime: Runtime, id: string): Promise<void> => {
  const agent = agentById(runtime, id);

  runtime.connections.delete(id);
  try {
    runtime.authority.revoke({ token: runtime.authority.rootToken, node: agent.name ?? agent.label });
  } catch {
    // Already gone from the tree: a restart, or an agent that never attached.
  }

  if (agent.name && agent.ensParentRegistry) {
    emit({ type: 'log', text: `clearing ${agent.name} …` });
    try {
      const ens = openEnsSigner();
      const resolver = agent.ensResolver ?? (await createEnsClient().resolverOf(agent.name)) ?? undefined;
      await revokeAgentName(
        { public: ens.public, wallet: ens.wallet },
        {
          parentRegistry: agent.ensParentRegistry as `0x${string}`,
          label: agent.label,
          name: agent.name,
          ...(resolver ? { resolver: resolver as `0x${string}` } : {}),
        },
      );
    } catch (error) {
      emit({ type: 'log', text: `${agent.name} could not be cleared on chain: ${(error as Error).message}` });
    }
  }

  agent.status = 'revoked';
  publish(runtime);
};

/**
 * Re-reads the wallet, and rebuilds the tree when money has arrived.
 *
 * The wallet was a snapshot taken at boot, which made a deposit invisible until
 * a restart — and the first-run screen promised the opposite, that the page
 * would notice by itself. It does now.
 *
 * Two different jobs, and only the first is cheap. Reading the balance is a
 * network call and always safe. Making new money *spendable* is not: the root
 * node's balance is fixed when the authority is created, so the only way to
 * raise it is to build a new authority — which discards the tree and every
 * capability issued from it. Agents are re-minted at their remaining balances
 * afterwards, exactly as they are at boot.
 *
 * So a rebuild waits until nothing is running. Replacing the tree under a live
 * task would revoke the capability it is paying with, and an agent cut off
 * mid-sentence because somebody topped up the wallet is a worse outcome than a
 * deposit that takes effect a minute later.
 */
export const refreshFunding = async (runtime: Runtime, isBusy: () => boolean): Promise<boolean> => {
  let wallet: OpenWallet;
  try {
    wallet = await openWallet(runtime.wallet.network, runtime.gate);
  } catch {
    // An RPC that did not answer is not news about anyone's balance.
    return false;
  }

  const before = runtime.wallet.spendableMinor;
  const changed =
    wallet.spendableMinor !== before ||
    wallet.shortfall !== runtime.wallet.shortfall ||
    wallet.heldMinor !== runtime.wallet.heldMinor;

  runtime.wallet = wallet;
  if (!changed) return false;

  if (wallet.spendableMinor > before && !isBusy()) {
    emit({ type: 'log', text: `wallet funded: ${formatAmount(wallet.network, wallet.spendableMinor)}` });
    runtime.authority = await authorityFor(wallet, runtime.gate, runtime.tab);
    runtime.connections.clear();

    for (const agent of runtime.crew.agents) {
      if (agent.status === 'revoked' || agent.network !== wallet.network) continue;
      try {
        await attach(runtime, agent);
        if (agent.status === 'broke' && BigInt(agent.budgetMinor) > BigInt(agent.spentMinor)) {
          agent.status = 'idle';
        }
      } catch {
        // Broke, or unattachable. `attach` has already recorded which.
      }
    }
  }

  publish(runtime);
  return true;
};

/**
 * Adds a directory to the crew's projects.
 *
 * Granting a path and granting it *to an agent* are separate acts, and keeping
 * them separate is what makes the second one cheap to undo. A project can exist
 * with nobody holding it.
 */
export const addProject = (
  runtime: Runtime,
  params: { name: string; path: string; mode: ProjectMode },
): Project => {
  const { path, warning } = describeGrant(params.path);

  const existing = runtime.crew.projects?.find(
    (project) => project.path.toLowerCase() === path.toLowerCase(),
  );
  if (existing) throw new Error(`${path} is already granted, as “${existing.name}”`);

  const project: Project = {
    id: newProjectId(),
    name: params.name.trim() || path,
    path,
    mode: params.mode,
    createdAt: Date.now(),
  };

  runtime.crew.projects = [...(runtime.crew.projects ?? []), project];
  if (warning) emit({ type: 'log', text: `${project.name}: ${warning}` });
  publish(runtime);
  return project;
};

/**
 * Removes a directory, and every agent's hold on it.
 *
 * Agents holding it are re-attached so their capabilities stop naming it. A
 * capability outliving the project it points at would be a grant enforced only
 * by the runtime forgetting to look — which is not enforcement.
 */
export const removeProject = async (runtime: Runtime, id: string): Promise<void> => {
  runtime.crew.projects = (runtime.crew.projects ?? []).filter((project) => project.id !== id);

  for (const agent of runtime.crew.agents) {
    if (!agent.grants?.some((grant) => grant.projectId === id)) continue;
    agent.grants = agent.grants.filter((grant) => grant.projectId !== id);
    if (BigInt(agent.budgetMinor) <= BigInt(agent.spentMinor)) continue;
    runtime.connections.delete(agent.id);
    try {
      runtime.authority.revoke({ token: runtime.authority.rootToken, node: agent.name ?? agent.label });
    } catch {
      // Not in the tree; nothing to withdraw before re-minting.
    }
    await attach(runtime, agent).catch(() => undefined);
  }

  publish(runtime);
};

/** What an agent may actually reach, resolved from ids to real paths. */
export const rootsFor = (runtime: Runtime, agent: Agent): Root[] => {
  const own = { root: workspacePathFor(agent.label), mode: 'write' as ProjectMode, name: 'your workspace' };
  const permitted = knownOnly(agent.permissions ?? DEFAULT_PERMISSIONS).includes('files:host');
  if (!permitted) return [own];

  const projects = runtime.crew.projects ?? [];
  return [
    own,
    ...(agent.grants ?? []).flatMap((grant) => {
      const project = projects.find((candidate) => candidate.id === grant.projectId);
      if (!project) return [];
      /*
        The narrower of the two. A project granted read-only cannot be handed to
        an agent as writable by editing the agent's row — the same `min` that
        governs every other narrowing here.
      */
      const mode: ProjectMode = project.mode === 'read' || grant.mode === 'read' ? 'read' : 'write';
      return [{ root: project.path, mode, name: project.name }];
    }),
  ];
};

export const agentById = (runtime: Runtime, id: string): Agent => {
  const agent = runtime.crew.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error('no such agent');
  return agent;
};

export const connectionFor = async (runtime: Runtime, agent: Agent): Promise<Connection> => {
  const existing = runtime.connections.get(agent.id);
  if (existing) return existing;
  return attach(runtime, agent);
};
