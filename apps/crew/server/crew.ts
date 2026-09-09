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
  serveAuthority,
  formatAmount,
  type Authority,
  type Connection,
  type ServedAuthority,
} from '../../../packages/sdk/src/index';
import {
  createEnsClient,
  ensNameGuard,
  ensureAgentName,
  openEnsSigner,
  revokeAgentName,
  registryOf,
  setProfile,
  ROOT_NAME,
} from '../../../packages/ens/src/index';
import { load, save, type Agent, type Crew } from './store';
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
  stop(): Promise<void>;
};

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
  const wallet = await openWallet(options.network);
  const crew = load();

  const authority = await createAuthority({
    signer: wallet.signer,
    secret: randomUUID(),
    fundedMinor: wallet.spendableMinor,
    /*
      Checked before every signature, which is what lets a name revoked on
      chain stop an agent that is already running. Nodes that are not names
      pass through untouched — the root is called `root` and always will be.
    */
    names: ensNameGuard({ suffix: '.eth' }),
  });

  const server = await serveAuthority(authorityHandler(authority), { port: AUTHORITY_PORT });

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

  const runtime: Runtime = {
    wallet,
    authority,
    gate: options.gate,
    connections: new Map(),
    crew,
    naming,
    server,
    async stop() {
      await server.close();
    },
  };

  /*
    Agents from previous runs are reconnected, not re-created. Their names are
    still on chain and their spend is still on file, but the authority's tree
    lives in memory and was rebuilt this boot — so the nodes their old
    capabilities named are gone, and each one is re-minted at its remaining
    balance.
  */
  for (const agent of crew.agents) {
    if (agent.status === 'revoked') continue;
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
  const promised = runtime.crew.agents
    .filter((existing) => existing.status !== 'revoked')
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
      .filter((other) => other.id !== agent.id && other.status !== 'revoked')
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
