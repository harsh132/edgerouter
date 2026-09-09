/**
 * `llm-edgerouter` — a DeepSeek Harness provider that pays for its own tokens.
 *
 * Install it, and the harness buys inference per call over x402 with a wallet.
 * There is no account and no API key: the gate settles before it serves, so it
 * extends no credit and has nobody to identify.
 *
 * Why a provider plugin rather than configuration: the harness can already
 * reach an OpenAI-compatible endpoint through a hand-declared `llm-pi-ai`
 * route, and doing that against edgerouter works right up to the point the gate
 * answers `402 Payment Required` — which nothing in the harness knows how to
 * pay. pi-ai's `transport` option selects SSE or WebSocket, not a request
 * implementation, so there is no seam to hand it a paying fetch. Owning the
 * adapter is what puts `payAndFetch` in the request path.
 *
 * ## Where the money comes from
 *
 * Three sources, and the default is the one that asks the user for nothing:
 *
 *   local        a wallet this plugin generates. The user sees an address and
 *                sends hbar to it; the account is created by that transfer.
 *                Nothing is typed, and no key ever passes through a form.
 *   environment  an account id and key from the environment. For CI and for
 *                anyone who already has a funded account they want used.
 *   authority    no key at all. Payments are signed by a budget authority that
 *                holds one, against an allowance this agent was delegated —
 *                which is how a sub-agent spends without being trusted.
 *
 * This package is a *bundle*: `dsh.bundle.patch` in its manifest points at
 * `cordis.patch.yml`, which is what makes `dsh plugin add` insert it into a
 * profile's layer stack rather than merely installing it as a dependency.
 *
 * @module dsh-plugin-edgerouter
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
import {
  connectAuthority,
  defaultMaxAmount,
  describe,
  evmSigner,
  formatAmount,
  hederaSigner,
  isEvmNetwork,
  loadOrCreateEvmWallet,
  loadOrCreateWallet,
  isGatewayNetwork,
  gatewayFunding,
  depositToGateway,
  type EvmWallet,
  type LocalWallet,
  type PaymentSigner,
} from '../../sdk/src/index';
import { EdgerouterAdapter, type Paid } from './adapter';
import { startDelegation, type Delegation } from './delegation';

export { EdgerouterAdapter } from './adapter';
export type { Paid, EdgerouterAdapterOptions } from './adapter';
export * from './convert';

export const name = 'llm-edgerouter';
export const inject = ['llm'];

/** The one provider route this plugin owns. */
const PROVIDER = 'edgerouter';
const NS = 'llm-edgerouter';

const DEFAULT_CAPABILITY_ENV = 'EDGEROUTER_CAPABILITY';
const DEFAULT_ACCOUNT_ENV = 'HEDERA_ACCOUNT_ID';
const DEFAULT_KEY_ENV = 'HEDERA_PRIVATE_KEY';
/**
 * The public gate.
 *
 * A default rather than a required field, and that is load-bearing: the Loader
 * composes this plugin with no configuration at all, so a required `baseURL`
 * would throw during boot and take the profile down with it. A default also
 * happens to be the honest one — the service is permissionless, so an install
 * with no configuration is a working install.
 */
const DEFAULT_BASE_URL = 'https://edgerouter-gate.prakashharsh32.workers.dev';
const DEFAULT_NETWORK = 'hedera:testnet';
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** How often an unfunded wallet re-asks whether anything has arrived. */
const FUNDING_POLL_MS = 20_000;

export type WalletSource = 'local' | 'environment' | 'authority';

export interface Config {
  /** Gate base URL. Defaults to the public gate. */
  baseURL?: string;
  /** Where payments are signed. `local` needs no setup at all. */
  wallet?: WalletSource;
  /** CAIP-2 network to pay on. */
  network?: string;
  /**
   * Ceiling for one call, in the asset's smallest unit.
   *
   * A string because it is a bigint and JSON has no such thing. Left unset it
   * takes a per-network default, because the smallest unit is not one unit:
   * `100000000` is one hbar on Hedera and one hundred USDC on Base. There is
   * no single number that is sensible on both, so there is no single default.
   */
  maxAmount?: string;
  /** Context capacity assumed when the gate does not say. */
  defaultContextWindow?: number;

  /** `environment` only: the account the money leaves. Public. */
  accountId?: string;
  /** `environment` only: variable holding the key. Never the key itself. */
  privateKeyEnv?: string;

  /** `authority` only: where the budget authority listens. */
  authorityUrl?: string;
  /** `authority` only: variable holding the delegated capability. */
  capabilityEnv?: string;

  /**
   * Reported, not configured: the address this plugin's wallet receives at.
   *
   * Written back into settings so it is visible where the provider is
   * configured, rather than only in a log line nobody reads. A user who has
   * just installed this needs one thing — an address to send funds to — and
   * the settings pane is where they are already looking.
   *
   * Editing it does nothing. The wallet is whatever key is on disk; this field
   * is overwritten from that key on every start.
   */
  walletAddress?: string;
  /** Reported, not configured: whether the wallet can pay yet, and what holds. */
  walletStatus?: string;

  /**
   * A command, not a setting: where to send the whole balance.
   *
   * The settings page writes an address here and this plugin acts on it, then
   * clears it — so a non-empty value means a withdrawal is in flight, and an
   * empty one means nothing is pending. It is deliberately not a stored
   * preference: a destination that survived a restart would be a wallet that
   * empties itself every time the harness boots.
   */
  withdrawTo?: string;
  /** Reported, not configured: how the last withdrawal went. */
  withdrawStatus?: string;

  /**
   * Whether this session claims an ENS name.
   *
   * Off by default, and that is not timidity: minting costs Sepolia gas, and a
   * provider that spends money the user did not ask it to spend is the exact
   * thing this project exists to argue against. Turning it on is the ask.
   */
  ensNames?: boolean;
  /** Reported, not configured: this session's name, once it has one. */
  ensName?: string;
  /** Reported, not configured: what the naming attempt did or why it did not. */
  ensStatus?: string;
  /** Reported: the most recent chat to be named. */
  ensChatName?: string;
  /**
   * Reported: every chat this session knows about, as JSON.
   *
   * Keyed by session id, so the sidebar tab can answer "what is *this* chat
   * called, and what has it cost" — the question a global settings page
   * cannot.
   */
  ensChats?: string;

  /**
   * Whether this session hands out allowances to sub-agents.
   *
   * Off by default. Turning it on starts a loopback server holding a budget: a
   * bearer capability reaching it can spend that budget, which is the intended
   * shape between an agent and its own sub-agents and nothing to enable idly.
   */
  delegation?: boolean;
  /** How much of the wallet delegation may hand out, smallest unit. */
  delegationBudget?: string;
  /**
   * Whether each chat spends its own allowance rather than the shared wallet.
   *
   * With this on, the first paid call from a chat mints that chat a budget out
   * of the delegation tree and pays through it. The chat becomes a teammate
   * with an expense account: you can see what it has spent, and cut it off
   * without touching anything else.
   *
   * Off by default, and it needs delegation running. A chat that cannot be
   * given an allowance falls back to the wallet rather than failing to pay —
   * this is a way to account for spending, not a new way for it to break.
   */
  perSessionBudgets?: boolean;
  /** What each chat is granted on its first paid call, smallest unit. */
  sessionBudget?: string;
  /** Reported: where sub-agents point, and what the tree currently holds. */
  delegationUrl?: string;
  delegationStatus?: string;
  /** Reported: the allowance tree, as JSON, for the settings page to render. */
  delegationTree?: string;

  /**
   * A command: how much USDC to deposit into Circle's Gateway, as a decimal
   * string. Cleared once acted on.
   *
   * Only meaningful on a Gateway network. Elsewhere paying draws on the
   * address directly and there is nothing to deposit into.
   */
  depositAmount?: string;

  /**
   * A command: `label|amountMinor|hours`. Cleared once acted on.
   *
   * Three fields in a string because settings carry scalars, and a mint needs
   * all three to be one decision — a partially applied mint is an allowance
   * with a size and no lifetime.
   */
  delegateMint?: string;
  /** A command: the allowance to revoke. Cleared once acted on. */
  delegateRevoke?: string;
  /**
   * Reported once, then cleared: the capability a sub-agent needs.
   *
   * The only moment a capability exists outside this process. It is bounded —
   * it spends its own node and nothing else — but it is a bearer token, so it
   * is shown once and wiped rather than kept in a file that syncs.
   */
  delegateCapability?: string;
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  wallet: z.union(['local', 'environment', 'authority'] as const).default('local'),
  network: z.string().default(DEFAULT_NETWORK),
  maxAmount: z.string(),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),

  accountId: z.string(),
  privateKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_ENV),

  authorityUrl: z.string(),
  capabilityEnv: z.string().role('credential-ref').default(DEFAULT_CAPABILITY_ENV),

  walletAddress: z.string().description('Send funds here. Reported by the plugin; editing does nothing.'),
  walletStatus: z.string().description('Reported by the plugin.'),

  withdrawTo: z
    .string()
    .description('Setting this sends the whole balance there, once. Cleared by the plugin.'),
  withdrawStatus: z.string().description('Reported by the plugin.'),

  ensNames: z
    .boolean()
    .default(false)
    .description('Claim an ENS name for this session. Costs Sepolia gas the first time.'),
  ensName: z.string().description('Reported by the plugin.'),
  ensStatus: z.string().description('Reported by the plugin.'),
  ensChatName: z.string().description('Reported by the plugin.'),
  ensChats: z.string().description('Reported by the plugin.'),

  delegation: z
    .boolean()
    .default(false)
    .description('Hand out spending allowances to sub-agents over loopback.'),
  delegationBudget: z.string().description('What delegation may hand out, smallest unit.'),
  perSessionBudgets: z
    .boolean()
    .default(false)
    .description('Give each chat its own allowance instead of sharing the wallet.'),
  sessionBudget: z.string().description('What each chat is granted, smallest unit.'),
  delegationUrl: z.string().description('Reported by the plugin.'),
  delegationStatus: z.string().description('Reported by the plugin.'),
  delegationTree: z.string().description('Reported by the plugin.'),
  depositAmount: z
    .string()
    .description('USDC to deposit into Circle Gateway, as a decimal. Cleared by the plugin.'),
  delegateMint: z.string().description('label|amountMinor|hours. Cleared by the plugin.'),
  delegateRevoke: z.string().description('An allowance to revoke. Cleared by the plugin.'),
  delegateCapability: z.string().description('Shown once by the plugin, then cleared.'),
});

/**
 * Whether an address is a plausible destination on this network.
 *
 * Checked before signing rather than left to the chain, because the two
 * networks take different-looking addresses and the failure mode of getting it
 * wrong is not symmetrical: an EVM address handed to Hedera's `AccountId`
 * parser throws, but a Hedera account id is a shape a careless parser could
 * accept, and there is no undoing a transfer that went somewhere real.
 */
export const isWithdrawDestination = (to: string, network: string): boolean =>
  isEvmNetwork(network) ? /^0x[0-9a-fA-F]{40}$/.test(to) : /^\d+\.\d+\.\d+$/.test(to);

/**
 * Reads and validates the per-call ceiling for one network.
 *
 * Unset takes the network's own default — see `defaultMaxAmount`, and note
 * that a number sensible on Hedera is a hundredfold on a six-decimal
 * stablecoin. Malformed is refused rather than defaulted: a cap that silently
 * became something else is not a cap, and the failure it prevents is
 * expensive.
 */
export const resolveMaxAmount = (raw: string | undefined, network: string): bigint => {
  const text = raw?.trim();
  if (!text) return defaultMaxAmount(network);
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `llm-edgerouter: maxAmount must be a whole number of the smallest unit, got "${text}"`,
    );
  }
  const value = BigInt(text);
  if (value <= 0n) throw new Error('llm-edgerouter: maxAmount must be greater than zero');
  return value;
};

/** Somewhere a wallet report can be delivered. */
export type ReportSink = (address: string, status: string) => void;

export type Reporter = {
  /** Report the current address and status. Repeats are dropped. */
  publish(address: string, status: string): void;
  /** Install the sink, replaying whatever was reported before it existed. */
  attach(sink: ReportSink): void;
};

/**
 * Buffers wallet reports until something can receive them.
 *
 * Both halves of this are load-bearing, and the second was learned the hard
 * way. Repeats are dropped because a settings write emits a change, a change
 * restarts the payment source, and the payment source reports — unguarded,
 * that is a loop.
 *
 * And the sink arrives late: `ctx.inject` runs when the settings service
 * becomes available, generally after the payment source has started and
 * already reported once. Without the replay, that first report goes nowhere,
 * the guard records it as sent, and every later report — identical — is
 * skipped. The settings page then says "no wallet yet" about a wallet that
 * exists, which is exactly what it did.
 */
export const createReporter = (): Reporter => {
  let sink: ReportSink | null = null;
  let sent = '';
  let last: { address: string; status: string } | null = null;

  return {
    publish(address, status) {
      const line = `${address}|${status}`;
      if (line === sent) return;
      sent = line;
      last = { address, status };
      sink?.(address, status);
    },
    attach(next) {
      sink = next;
      if (last) next(last.address, last.status);
    },
  };
};

export function apply(ctx: Context, config: Config): void {
  /*
    The authoritative config is a thunk, not the value handed to `apply`.

    A settings section can replace it while the plugin is running, and the
    harness's own adapters resolve connection facts per request for exactly this
    reason: a changed gate or cap should reach the next call without a restart,
    while a request already in flight keeps the facts it started with.
  */
  let current: () => Config = () => config;

  /*
    A bad `maxAmount` from a live settings edit must not take the provider down
    — the user is typing into a form. The last good value keeps serving and the
    reason is said once, which is the same trade `llm-deepseek` makes for its
    own beyond-schema bounds.
  */
  let lastGoodMax = resolveMaxAmount(config.maxAmount, config.network ?? DEFAULT_NETWORK);
  let complainedAboutMax = false;
  const maxAmount = (): bigint => {
    try {
      const now = current();
      lastGoodMax = resolveMaxAmount(now.maxAmount, now.network ?? DEFAULT_NETWORK);
      complainedAboutMax = false;
    } catch (error) {
      if (!complainedAboutMax) {
        complainedAboutMax = true;
        ctx.logger.error(`llm-edgerouter: keeping the last good cap — ${(error as Error).message}`);
      }
    }
    return lastGoodMax;
  };

  const connection = () => {
    const now = current();
    return {
      baseURL: now.baseURL ?? DEFAULT_BASE_URL,
      // The gate is permissionless, so nothing is sent in this slot. It stays
      // in the shape because an attenuated capability *narrowing* what a
      // request may do is a thing the gate still understands.
      capability: '',
      maxAmount: maxAmount(),
      network: now.network ?? DEFAULT_NETWORK,
      defaultContextWindow: now.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  };

  /*
    One resolved signer, and one sentence saying why there isn't one.

    Both are needed because the interesting failure is not "misconfigured" — it
    is "correctly configured, waiting for money", which no amount of checking
    settings will fix. The user needs an address, not a form.
  */
  let signer: PaymentSigner | undefined;
  let unavailable = 'the payment source has not finished starting up';
  let wallet: LocalWallet | undefined;
  let evmWallet: EvmWallet | undefined;
  let source: WalletSource | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  /**
   * The balance as last read, so a later read can be told apart from the same
   * read repeated. Only a withdrawal needs this: it is the one moment the
   * balance changes because of something happening here, and the one moment
   * "the number has not moved yet" and "the number is correct" look identical.
   */
  let lastBalanceMinor: bigint | undefined;

  /**
   * Re-reads the balance until it reflects a transfer that already happened.
   *
   * A receipt says the transfer succeeded on consensus; it does not say the
   * mirror node has caught up, and the mirror node is what the balance is read
   * from. Reading once immediately after a sweep therefore reports the old
   * number — and reports it as settled, because it looks exactly like a correct
   * read. The poll that would have corrected it has already stopped, since a
   * funded wallet has nothing left to wait for.
   *
   * So the change is waited for rather than assumed, and the wait is bounded:
   * if the mirror node is far enough behind that thirty seconds does not cover
   * it, the next read of any kind will pick it up, and a number that is briefly
   * stale is better than a plugin that hangs on one.
   */
  const settleBalance = async (): Promise<void> => {
    const before = lastBalanceMinor;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (wallet) await checkFunding(false);
      else if (evmWallet) await checkEvmFunding(false);
      else return;
      if (lastBalanceMinor !== before) return;
    }
    ctx.logger.warn(
      'llm-edgerouter: the withdrawal is done, but the balance shown has not caught up yet',
    );
  };

  const clearPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  /**
   * Reads the local wallet's funding state, and says the useful thing.
   *
   * Announced on transition rather than on every poll: a line every twenty
   * seconds saying nothing has changed is how a log stops being read.
   */
  const checkFunding = async (announce: boolean): Promise<void> => {
    if (!wallet) return;
    try {
      const funding = await wallet.refresh();
      if (!funding.funded) {
        signer = undefined;
        // Recorded on this branch too, so a sweep that empties the account is a
        // balance that *changed* rather than one that was never read.
        lastBalanceMinor = 0n;
        unavailable = [
          'this wallet has no funds yet.',
          ``,
          `  Send testnet hbar to   ${wallet.evmAddress}`,
          `  Get some at            https://portal.hedera.com/faucet`,
          `  Watch for it with      npx dsh-plugin-edgerouter watch`,
          ``,
          'The account is created by that first transfer — there is nothing to',
          'register and no fee to pay before you can receive.',
        ].join('\n');
        publish(
          wallet.evmAddress,
          'waiting for funds — send hbar to walletAddress',
        );
        if (announce) {
          ctx.logger.info(`llm-edgerouter: send hbar to ${wallet.evmAddress} to start paying`);
        }
        return;
      }
      const first = signer === undefined;
      signer = wallet.signer();
      lastBalanceMinor = funding.balanceMinor;
      // Delegation needs a signer, and at boot there is not one yet — the
      // wallet may be unfunded, or the mirror node may still be answering. This
      // is the moment that changes, so it is the moment to try again.
      if (first) void syncDelegation();
      publish(
        wallet.evmAddress,
        `ready — ${funding.accountId} holds ${formatAmount(wallet.network, funding.balanceMinor)}`,
      );
      if (first) {
        ctx.logger.info(
          `llm-edgerouter: funded — ${funding.accountId} holds ${formatAmount(wallet.network, funding.balanceMinor)}`,
        );
      }
      // Nothing further to wait for; the balance itself is checked per payment
      // by the network, which is the only place it can be checked honestly.
      clearPolling();
    } catch (error) {
      unavailable = `could not read the wallet's funding state: ${(error as Error).message}`;
      if (announce) ctx.logger.warn(`llm-edgerouter: ${unavailable}`);
    }
  };

  /*
    Writes the address and status back into settings, when there is a settings
    service to write to.

    Guarded against writing what is already there, because `update` emits a
    change, and a change restarts the payment source, which would report again:
    an unguarded write is an infinite loop that looks like a working feature
    until the log fills up.
  */
  /*
    The address goes into the settings section, and the plugin's own settings
    page renders it — see `src/client.tsx`.

    It briefly went into the provider's display name too, because Desktop's
    Models pane renders a provider section as an endpoint-and-key profile and
    shows none of our fields. That worked and looked terrible: a truncated
    address, repeated in the row and the edit panel, in a field that is supposed
    to name a thing rather than report on it. A settings page is the right
    answer to "the user cannot see this", and a name is not.
  */
  const reporter = createReporter();

  /*
    A second reporter, for the same reason as the first: naming finishes at an
    unpredictable moment, generally before the settings service exists, and a
    report that arrives before anything is listening must not be dropped.
  */
  const nameReporter = createReporter();
  const reportName = (name: string, status: string) => nameReporter.publish(name, status);

  /*
    Delegation's own reporter. Same reason again — the tree changes at moments
    nobody is waiting for, and a report that lands before the settings service
    exists must be replayed rather than dropped.
  */
  const treeReporter = createReporter();
  let delegation: Delegation | null = null;

  /*
    Chats already named, so a chat that makes twenty calls mints once.

    In memory, and that is the right lifetime: `ensureAgentName` resolves before
    it mints, so the worst a restart costs is one extra lookup per chat rather
    than a duplicate registration.
  */
  const namedChats = new Set<string>();
  const chatReporter = createReporter();

  /**
   * What each chat is called and what it has spent.
   *
   * Published for the sidebar tab, which is the one surface that knows *which*
   * chat is being looked at. Settings are global, so the page can only ever
   * show the latest of anything; a per-chat panel asks a different question —
   * "what has this conversation cost me" — and can only answer it from a map.
   *
   * Keyed by session id and rendered on this side, because the browser half
   * cannot hash a session id into a label without pulling a chain library into
   * a settings page.
   */
  type ChatLedger = { name: string; spentMinor: string; spent: string; calls: number };
  const chats = new Map<string, ChatLedger>();
  /** Enough to cover a working day; a settings document is not a database. */
  const MAX_CHATS = 24;

  const chatEntry = (sessionId: string): ChatLedger => {
    const found = chats.get(sessionId);
    if (found) return found;
    const fresh: ChatLedger = { name: '', spentMinor: '0', spent: '', calls: 0 };
    chats.set(sessionId, fresh);
    // Oldest out first. `Map` iterates in insertion order, so the first key is
    // the least recently *created* chat — which is the one worth forgetting.
    while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value!);
    return fresh;
  };

  const publishChats = (latest: string) =>
    chatReporter.publish(latest, JSON.stringify(Object.fromEntries(chats)));

  /**
   * Gives a chat its own name, the first time it spends.
   *
   * On first payment rather than on first message, deliberately. Naming costs
   * gas, and a chat that has not bought anything is not an agent that acts —
   * naming every opened window would spend real money to record that somebody
   * typed "hi".
   *
   * The name hangs beneath this install's own name, so the hierarchy says what
   * is true: one wallet, many chats, and sub-agents beneath those.
   */
  const nameChat = async (sessionId: string | undefined): Promise<void> => {
    const now = current();
    if (!sessionId || !now.ensNames || !now.ensName) return;
    if (namedChats.has(sessionId)) return;
    // Claimed before the await, so twenty concurrent calls mint once.
    namedChats.add(sessionId);

    try {
      const { chatLabelFor, ensureAgentName, openEnsSigner } = await import('../../ens/src/index');
      const ensSigner = openEnsSigner();
      const named = await ensureAgentName(
        { public: ensSigner.public, wallet: ensSigner.wallet },
        {
          label: chatLabelFor(sessionId),
          parent: now.ensName,
          owner: ensSigner.address,
        },
      );
      chatEntry(sessionId).name = named.name;
      publishChats(named.name);
      if (named.minted) ctx.logger.info(`llm-edgerouter: this chat is ${named.name}`);
    } catch (error) {
      /*
        Forgotten rather than remembered as done, so the next call can try
        again. A chat that failed to be named is not a chat that must stay
        anonymous.
      */
      namedChats.delete(sessionId);
      ctx.logger.warn(
        `llm-edgerouter: could not name this chat — ${(error as Error).message}`,
      );
    }
  };

  /** Publishes the allowance tree as the settings page wants to read it. */
  const reportTree = () => {
    if (!delegation) {
      treeReporter.publish('', 'not running');
      return;
    }
    const state = delegation.view();
    treeReporter.publish(state.url, JSON.stringify({ status: state.status, allowances: state.allowances }));
  };

  /**
   * Starts or stops the loopback authority to match the settings.
   *
   * The budget is taken from settings and defaults to the per-call cap times
   * twenty — a number with no theory behind it beyond "enough to delegate a few
   * allowances from", chosen because a required field here would mean
   * delegation could not be switched on with one click.
   */
  const syncDelegation = async (): Promise<void> => {
    const now = current();

    if (!now.delegation) {
      if (delegation) {
        await delegation.stop();
        delegation = null;
        /*
          Every per-chat signer talks to that authority over loopback, so they
          are now pointing at a closed socket. Dropped rather than left to fail
          one call at a time.
        */
        sessionSigners.clear();
        ctx.logger.info('llm-edgerouter: delegation stopped');
      }
      reportTree();
      return;
    }
    if (delegation) return;

    if (!signer) {
      treeReporter.publish('', `cannot delegate yet — ${unavailable}`);
      return;
    }

    try {
      const network = now.network ?? DEFAULT_NETWORK;

      /*
        The budget is an accounting fiction over one real wallet, so it has to
        be bounded by what that wallet actually holds.

        Without this the default — twenty times the per-call cap — happily
        claimed twenty hbar against a wallet holding two, and every allowance
        cut from it was a promise the wallet could not keep. The failure would
        arrive at the worst moment and in the worst form: not a clean
        `budget_exhausted` from the authority, which a sub-agent knows how to
        stop on, but a signed payment the network rejects for insufficient
        balance.

        Clamping is the honest bound. It is still not a guarantee — the wallet
        pays for this session's own calls too, and the balance moves under both
        — but a ceiling of "what exists" beats a ceiling of "what was asked
        for".
      */
      const asked = now.delegationBudget?.trim()
        ? BigInt(now.delegationBudget.trim())
        : maxAmount() * 20n;
      const held = lastBalanceMinor ?? 0n;
      const budget = held > 0n && asked > held ? held : asked;
      const clamped = budget !== asked;

      /*
        The guard is attached only when naming is on. Without a name there is
        nothing to check, and refusing every allowance for lacking one would
        make delegation depend on a chain the payment does not touch.
      */
      const names = now.ensNames
        ? (await import('../../ens/src/index')).ensNameGuard()
        : undefined;

      delegation = await startDelegation({
        signer,
        network,
        fundedMinor: budget,
        ...(names ? { names } : {}),
        log: (line) => ctx.logger.info(line),
      });
      if (clamped) {
        ctx.logger.info(
          `llm-edgerouter: delegation budget capped at ${formatAmount(network, budget)} — ` +
            `the wallet does not hold the ${formatAmount(network, asked)} that was asked for`,
        );
      }
      reportTree();
    } catch (error) {
      const message = (error as Error).message;
      treeReporter.publish('', `delegation failed to start: ${message}`);
      ctx.logger.error(`llm-edgerouter: delegation failed to start — ${message}`);
    }
  };

  /**
   * The same, for an EVM chain.
   *
   * Separate because the state it reports is different, not because the code
   * would not compress. There is no "account does not exist yet" here — an EVM
   * address always exists — so the only question is whether anyone has sent it
   * the token the gate quotes, and the message says exactly that.
   */
  /**
   * Funding, as a Gateway network measures it.
   *
   * Reports both numbers because they mean different things and the difference
   * is the whole user-facing story: money at the address is one step from
   * spendable, money in the Gateway is spendable now. Saying only "cannot pay"
   * would hide which step is missing.
   */
  const checkGatewayFunding = async (announce: boolean): Promise<void> => {
    if (!evmWallet) return;
    try {
      const funding = await gatewayFunding({
        privateKey: evmWallet.exportPrivateKey(),
        network: evmWallet.network,
        address: evmWallet.address,
      });
      lastBalanceMinor = funding.availableMinor;

      if (!funding.canPay) {
        signer = undefined;
        const held = formatAmount(evmWallet.network, funding.walletMinor);
        unavailable =
          funding.walletMinor > 0n
            ? [
                `this wallet holds ${held} but has deposited none of it.`,
                ``,
                'Circle Gateway pays from a deposited balance, not from the address',
                'directly. Deposit in Settings, or with:',
                ``,
                `  npx dsh-plugin-edgerouter deposit --network ${evmWallet.network}`,
              ].join('\n')
            : [
                'this wallet holds no USDC yet.',
                ``,
                `  Send USDC to  ${evmWallet.address}`,
                `  Get some at   https://faucet.circle.com`,
                ``,
                'Then deposit it into the Gateway, which is what payment is drawn from.',
              ].join('\n');

        publish(
          evmWallet.address,
          funding.walletMinor > 0n
            ? `holds ${held}, none deposited — deposit to start paying`
            : 'waiting for funds — send USDC to walletAddress',
        );
        if (announce) ctx.logger.info(`llm-edgerouter: ${unavailable.split('\n')[0]}`);
        return;
      }

      const first = signer === undefined;
      signer = evmWallet.signer();
      /*
        The same retry the other two funding paths do, and it was missing here:
        delegation needs a signer, at boot there is not one, and this is the
        moment that changes. Without it the settings page shows a ready wallet
        above a delegation card still saying the payment source has not
        started — which is what it did.
      */
      if (first) void syncDelegation();
      /*
        Both numbers, once there is something to say about both.

        The undeposited remainder was only ever mentioned while it was the
        problem — a wallet holding USDC with nothing deposited. After a
        deposit it vanished from the UI, which reads as though the rest of the
        money is gone rather than one step away from being spendable. Only the
        deposited half can pay, so that stays the headline; the remainder is a
        footnote, not a second balance competing with it.
      */
      const undeposited =
        funding.walletMinor > 0n
          ? `, ${formatAmount(evmWallet.network, funding.walletMinor)} in the wallet not yet deposited`
          : '';
      publish(
        evmWallet.address,
        `ready — ${formatAmount(evmWallet.network, funding.availableMinor)} deposited in the Gateway${undeposited}`,
      );
      if (first) {
        ctx.logger.info(
          `llm-edgerouter: funded — ${formatAmount(evmWallet.network, funding.availableMinor)} in the Gateway${undeposited}`,
        );
      }
      clearPolling();
    } catch (error) {
      unavailable = `could not read the Gateway balance: ${(error as Error).message}`;
      if (announce) ctx.logger.warn(`llm-edgerouter: ${unavailable}`);
    }
  };

  const checkEvmFunding = async (announce: boolean): Promise<void> => {
    if (!evmWallet) return;

    /*
      A Gateway network is asked a different question.

      Everywhere else "can this wallet pay" means "does it hold the token". On
      Arc it does not: payment comes from a balance deposited into the
      GatewayWallet, so an address holding twenty USDC and nothing deposited
      pays for nothing. Reporting the token balance there would show a funded,
      ready wallet that refuses every call — the most confusing failure this
      plugin could produce.
    */
    if (isGatewayNetwork(evmWallet.network)) {
      await checkGatewayFunding(announce);
      return;
    }

    try {
      const funding = await evmWallet.refresh();
      if (!funding.canPay) {
        signer = undefined;
        lastBalanceMinor = funding.tokenMinor;
        unavailable = [
          'this wallet holds no USDC yet.',
          ``,
          `  Send USDC to      ${evmWallet.address}`,
          `  Get some at       https://faucet.circle.com`,
          `  Watch for it with npx dsh-plugin-edgerouter watch --network ${evmWallet.network}`,
          ``,
          'Paying costs no gas, so USDC alone is enough to start.',
        ].join('\n');
        publish(
          evmWallet.address,
          'waiting for funds — send USDC to walletAddress',
        );
        if (announce) {
          ctx.logger.info(`llm-edgerouter: send USDC to ${evmWallet.address} to start paying`);
        }
        return;
      }
      const first = signer === undefined;
      signer = evmWallet.signer();
      lastBalanceMinor = funding.tokenMinor;
      if (first) void syncDelegation();
      publish(
        evmWallet.address,
        `ready — holds ${formatAmount(evmWallet.network, funding.tokenMinor)}`,
      );
      if (first) {
        ctx.logger.info(
          `llm-edgerouter: funded — ${evmWallet.address} holds ${formatAmount(evmWallet.network, funding.tokenMinor)}`,
        );
      }
      clearPolling();
    } catch (error) {
      unavailable = `could not read the wallet's balance: ${(error as Error).message}`;
      if (announce) ctx.logger.warn(`llm-edgerouter: ${unavailable}`);
    }
  };

  /**
   * Builds the payment source named by the settings.
   *
   * Asynchronous and fire-and-forget, because `apply` must return promptly —
   * a profile that waits on a mirror node before it finishes booting is a
   * profile that fails to boot when the mirror node is slow. Until this
   * resolves the provider is registered and refuses with a reason, which is
   * strictly better than not existing.
   */
  const start = async (): Promise<void> => {
    const now = current();
    const network = now.network ?? DEFAULT_NETWORK;
    source = now.wallet ?? 'local';
    signer = undefined;
    wallet = undefined;
    evmWallet = undefined;
    clearPolling();

    try {
      if (source === 'environment') {
        const accountId = now.accountId ?? process.env[DEFAULT_ACCOUNT_ENV];
        const privateKey = process.env[now.privateKeyEnv ?? DEFAULT_KEY_ENV];
        // An EVM address is derived from its key, so only Hedera needs to be
        // told which account it is paying from.
        if ((!accountId && !isEvmNetwork(network)) || !privateKey) {
          unavailable = `wallet is set to "environment" but ${DEFAULT_ACCOUNT_ENV} or ${now.privateKeyEnv ?? DEFAULT_KEY_ENV} is not set`;
          return;
        }
        if (isEvmNetwork(network)) {
          signer = evmSigner({ privateKey, network });
        } else {
          // Narrowed rather than asserted: the guard above only requires an
          // account id on the Hedera branch, and the compiler is right that the
          // two facts are not connected by anything it can see.
          if (!accountId) {
            unavailable = `wallet is set to "environment" but ${DEFAULT_ACCOUNT_ENV} is not set`;
            return;
          }
          signer = hederaSigner({ accountId, privateKey, network });
        }
        ctx.logger.info(`llm-edgerouter: paying from ${signer.accountId} on ${network}`);
        return;
      }

      if (source === 'authority') {
        const url = now.authorityUrl;
        const capability = process.env[now.capabilityEnv ?? DEFAULT_CAPABILITY_ENV];
        if (!url || !capability) {
          unavailable = `wallet is set to "authority" but authorityUrl or ${now.capabilityEnv ?? DEFAULT_CAPABILITY_ENV} is missing`;
          return;
        }
        const connected = await connectAuthority({
          url,
          capability,
          resourceUrl: now.baseURL ?? DEFAULT_BASE_URL,
        });
        signer = connected.signer;
        ctx.logger.info(
          `llm-edgerouter: spending the "${connected.node}" allowance, paid from ${connected.account}`,
        );
        return;
      }

      if (isEvmNetwork(network)) {
        const handle = loadOrCreateEvmWallet({ network });
        evmWallet = handle.wallet;
        if (handle.created) {
          ctx.logger.info(`llm-edgerouter: generated a wallet — ${describe(handle.path)}`);
        }
        await checkEvmFunding(true);
        if (!signer) timer = setInterval(() => void checkEvmFunding(false), FUNDING_POLL_MS);
        return;
      }

      const handle = loadOrCreateWallet({ network });
      wallet = handle.wallet;
      if (handle.created) {
        ctx.logger.info(`llm-edgerouter: generated a wallet — ${describe(handle.path)}`);
      }
      await checkFunding(true);
      /*
        Polled only while unfunded. Funding happens outside this process, so
        there is nothing to react to; and it stops the moment money arrives,
        because after that the balance is the network's business.
      */
      if (!signer) timer = setInterval(() => void checkFunding(false), FUNDING_POLL_MS);
    } catch (error) {
      // The key is never in the message; `hederaSigner` guarantees that, and
      // nothing here adds it back.
      unavailable = (error as Error).message;
      ctx.logger.error(`llm-edgerouter: ${unavailable}`);
    }
  };

  /*
    Registered as an effect so the poll stops when the plugin unloads. `effect`
    is how cordis 4 ties a disposer to a fiber's lifetime — the harness's own
    services use it — but it is mixed onto the context at runtime rather than
    declared on the `Context` interface, hence the cast.
  */
  (ctx as unknown as { effect(run: () => () => void): unknown }).effect(() => () => {
    clearPolling();
    // The authority holds a listening socket. Leaving one behind on unload
    // would keep a port — and a budget — alive with nothing owning it.
    void delegation?.stop();
  });

  /*
    A running total for the session, printed on every call because the entire
    proposition is that the user is spending real money — the moment that
    becomes invisible, this is just a slower API key.
  */
  let spent = 0n;
  let calls = 0;
  const onPaid = (paid: Paid) => {
    spent += paid.amount;
    calls += 1;

    if (paid.sessionId) {
      /*
        Recorded whether or not naming is on. A chat's cost is worth knowing
        even when nobody has paid to give it a name, and tying the two together
        would hide the cheaper fact behind the expensive one.
      */
      const entry = chatEntry(paid.sessionId);
      const total = BigInt(entry.spentMinor) + paid.amount;
      entry.spentMinor = total.toString();
      entry.spent = formatAmount(paid.network, total);
      entry.calls += 1;
      publishChats(entry.name);
    }

    // Fire and forget: a name is worth having, and never worth delaying a
    // response the user has already paid for.
    void nameChat(paid.sessionId);
    const each =
      `${formatAmount(paid.network, paid.amount)}` +
      ` (total ${formatAmount(paid.network, spent)} over ${calls})`;
    ctx.logger.info(
      `paid ${each} for ${paid.model} — sign ${paid.signingMs}ms, call ${paid.requestMs}ms` +
        (paid.transaction ? ` — ${paid.transaction}` : ''),
    );
  };

  /**
   * One signer per chat, when chats have their own budgets.
   *
   * The entry is the promise, not the signer, and that is deliberate: a chat
   * that fires three calls at once must mint one allowance, not three. Storing
   * the in-flight promise makes the second and third callers wait for the first
   * rather than race it.
   */
  const sessionSigners = new Map<string, Promise<PaymentSigner | undefined>>();

  /**
   * Mints a chat its own allowance and connects to it.
   *
   * Returns undefined rather than throwing on every failure path, because the
   * caller falls back to the wallet. A chat that cannot be given a budget
   * should still be able to work — this feature accounts for spending, it does
   * not gate it.
   */
  const openSessionSigner = async (sessionId: string): Promise<PaymentSigner | undefined> => {
    const now = current();
    if (!delegation) return undefined;

    try {
      const network = now.network ?? DEFAULT_NETWORK;
      const amountMinor = now.sessionBudget?.trim()
        ? BigInt(now.sessionBudget.trim())
        : maxAmount() * 5n;

      /*
        The allowance is named after the chat, and when ENS naming is on it is
        named with the chat's *ENS name* — so the node the authority charges and
        the name the guard resolves are one string, and revoking the name stops
        the spending.
      */
      const { chatLabelFor } = await import('../../ens/src/index');
      const label = chatLabelFor(sessionId);
      const child = now.ensNames && now.ensName ? `${label}.${now.ensName}` : label;

      const capability = await delegation.mint({ child, amountMinor, hours: 24 });
      const connected = await connectAuthority({
        url: delegation.url,
        capability,
        resourceUrl: now.baseURL ?? DEFAULT_BASE_URL,
      });

      reportTree();
      ctx.logger.info(
        `llm-edgerouter: ${child} has its own budget of ${formatAmount(network, amountMinor)}`,
      );
      return connected.signer;
    } catch (error) {
      /*
        Logged once per chat, not per call: the map holds this promise, so a
        failure is remembered as "no allowance" and the wallet is used from
        here on rather than retried on every message.
      */
      ctx.logger.warn(
        `llm-edgerouter: could not give this chat its own budget — ${(error as Error).message}`,
      );
      return undefined;
    }
  };

  /**
   * The signer for one call.
   *
   * Falls through to the wallet in every case where a chat has no allowance —
   * the feature is off, delegation is not running, the mint failed, or the call
   * carries no session at all. Payment working is not conditional on
   * accounting working.
   */
  const signerFor = async (sessionId?: string): Promise<PaymentSigner | undefined> => {
    if (!sessionId || !current().perSessionBudgets) return signer;

    let pending = sessionSigners.get(sessionId);
    if (!pending) {
      pending = openSessionSigner(sessionId);
      sessionSigners.set(sessionId, pending);
    }
    return (await pending) ?? signer;
  };

  const adapter = new EdgerouterAdapter({
    connection,
    signer: signerFor,
    unavailableReason: () => unavailable,
    onPaid,
  });

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'edgerouter', settingsNs: NS, settingsPath: [] },
  ]);

  /**
   * Says where the money goes, everywhere that will listen.
   *
   * Guarded against repeating itself, because a settings write emits a change,
   * a change restarts the payment source, and the payment source publishes —
   * unguarded, that is a loop which looks like a working feature until the log
   * fills up.
   */
  const publish = (address: string, status: string) => reporter.publish(address, status);

  /**
   * Writes the report into settings, retrying a lock, and naming it when it
   * persists.
   *
   * The settings file is written atomically — a temporary file, then a rename
   * over the real one — and on Windows that rename fails outright while any
   * other process holds the destination open. An editor with the file open is
   * enough. The failure surfaces nowhere useful: the write is a convenience, so
   * it is caught, and the settings page then reports "no wallet yet" about a
   * wallet that exists and is being logged about two lines up.
   *
   * A lock held by a save is momentary, so it is retried. A lock held by an
   * open editor is not, so after the retries the log says what is actually
   * wrong instead of repeating an errno at somebody.
   */
  const reportIntoSettings = async (
    settingsCtx: { settings: { update(ns: string, patch: object): Promise<unknown> } },
    address: string,
    status: string,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await settingsCtx.settings.update(NS, { walletAddress: address, walletStatus: status });
        return;
      } catch (error) {
        const message = (error as Error).message;
        const locked = /EPERM|EBUSY|EACCES/.test(message);
        if (locked && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          continue;
        }
        ctx.logger.warn(
          locked
            ? `llm-edgerouter: the settings file is held open by another program, so the wallet` +
                ` address could not be written into it. Close it in whatever has it open` +
                ` (an editor started from "Open configuration file" will do this) and restart.` +
                ` The address is ${address} — ${message}`
            : `llm-edgerouter: could not report the wallet address into settings: ${message}`,
        );
        return;
      }
    }
  };

  /**
   * Claims this session's ENS name, if asked to.
   *
   * Deliberately not part of `start()`. Naming is slow — a read against
   * Sepolia, and on the first run a transaction and a block — and payment must
   * not wait on it. A session with no name pays exactly as it did before;
   * naming is something that becomes true a few seconds later, or does not.
   *
   * Also deliberately off by default. Minting costs gas from the user's wallet,
   * and a provider that spends money nobody asked it to spend is the thing this
   * project exists to argue against.
   */
  const claimName = async (): Promise<void> => {
    if (!current().ensNames) return;

    try {
      // Imported here rather than at the top: a profile that never turns naming
      // on should not pay to load an ENS client and a chain's worth of ABIs.
      const { ensureSessionName, openEnsSigner } = await import('../../ens/src/index');
      const signer = openEnsSigner();

      const gas = await signer.public.getBalance({ address: signer.address });
      if (gas === 0n) {
        reportName('', `no Sepolia ETH at ${signer.address}, so no name can be claimed`);
        return;
      }

      const session = await ensureSessionName(
        { public: signer.public, wallet: signer.wallet },
        { owner: signer.address, gate: current().baseURL ?? DEFAULT_BASE_URL },
      );

      reportName(
        session.name,
        session.minted ? `minted — ${session.registerHash}` : 'already registered',
      );
      ctx.logger.info(
        `llm-edgerouter: this session is ${session.name}` +
          (session.minted ? ' (newly minted)' : ''),
      );
    } catch (error) {
      const message = (error as Error).message;
      reportName('', `could not claim a name: ${message}`);
      ctx.logger.warn(`llm-edgerouter: could not claim an ENS name — ${message}`);
    }
  };

  /*
    Started last, after everything it publishes into exists.

    It would in fact survive being started earlier — the first thing it awaits
    is a network read, so `apply` returns long before anything is published —
    but that is an accident of where an await happens to sit, and a later edit
    that moves one would turn it into a use-before-declaration at runtime.
  */
  void start();
  void claimName();
  void syncDelegation();
  ctx.llm.registerAdapter([PROVIDER], adapter);

  /*
    Optional injection. The settings service is what makes the `llm-edgerouter:`
    section in a profile's settings file mean anything; without it the
    composition entry is the whole configuration, which is still a working
    plugin — just one you have to restart to reconfigure.
  */
  ctx.inject(['settings'], (settingsCtx) => {
    reporter.attach((address, status) => {
      /*
        Fire and forget, and a failure is logged rather than raised. This is a
        convenience — the address is also in the logs and in the refusal a call
        would get — so a settings service that refuses a write must not take the
        provider down with it.
      */
      void reportIntoSettings(settingsCtx, address, status);
    });

    /**
     * Acts on a `withdrawTo` written by the settings page, exactly once.
     *
     * Read as a command and cleared *before* the transfer, not after. That
     * ordering is the whole safety argument: a crash between the two leaves an
     * empty field and an unmade transfer, whereas clearing afterwards leaves a
     * standing instruction that would be replayed on the next start — and a
     * wallet that empties itself on boot is a worse bug than a withdrawal that
     * has to be asked for twice.
     *
     * For the same reason it only ever runs from a change, never from startup:
     * a value already in the file when the plugin loads was not a click.
     */
    treeReporter.attach((delegationUrl, delegationStatus) => {
      /*
        Two fields from one report: the URL a sub-agent points at, and the tree
        itself as JSON. The status line doubles as the tree because a reporter
        carries two strings — which is enough, and cheaper than a third channel
        that could disagree with this one.
      */
      const tree = delegationStatus.startsWith('{') ? delegationStatus : '';
      const status = tree ? (JSON.parse(tree) as { status: string }).status : delegationStatus;
      void settingsCtx.settings
        .update(NS, { delegationUrl, delegationStatus: status, delegationTree: tree })
        .catch((error: unknown) =>
          ctx.logger.warn(
            `llm-edgerouter: could not report the allowance tree: ${(error as Error).message}`,
          ),
        );
    });

    /**
     * Mints an allowance, names it, and shows the capability once.
     *
     * The ENS name is minted *before* the capability is reported, and that
     * order is the point: with naming on, the authority refuses to sign for a
     * node whose name does not resolve, so handing out a capability whose name
     * does not exist yet would be handing out something that cannot spend.
     */
    const runMint = async (command: string): Promise<void> => {
      const [label, amountText, hoursText] = command.split('|');
      const clear = () => settingsCtx.settings.update(NS, { delegateMint: '' }).catch(() => {});

      try {
        await clear();

        if (!delegation) throw new Error('delegation is not running');
        if (!label || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(label)) {
          throw new Error(`"${label}" is not a usable allowance name (a-z, 0-9 and dashes)`);
        }
        const amountMinor = BigInt(amountText ?? '0');
        if (amountMinor <= 0n) throw new Error('an allowance needs an amount above zero');
        const hours = Number(hoursText ?? '24');
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('hours must be above zero');

        const now = current();
        /*
          The allowance id is the ENS name when there is one. That is what makes
          the two trees one tree: the node the authority charges and the name
          the guard resolves are the same string.
        */
        const sessionName = now.ensName;
        const child = sessionName ? `${label}.${sessionName}` : label;

        if (sessionName && now.ensNames) {
          const { ensureAgentName, openEnsSigner } = await import('../../ens/src/index');
          const ensSigner = openEnsSigner();
          await ensureAgentName(
            { public: ensSigner.public, wallet: ensSigner.wallet },
            {
              label,
              parent: sessionName,
              owner: ensSigner.address,
              grantedMinor: amountMinor,
              asset: now.network ?? DEFAULT_NETWORK,
              gate: now.baseURL ?? DEFAULT_BASE_URL,
            },
          );
        }

        const capability = await delegation.mint({ child, amountMinor, hours });
        reportTree();
        await settingsCtx.settings.update(NS, {
          delegateCapability: capability,
          delegationStatus: `minted ${child}`,
        });
      } catch (error) {
        const message = (error as Error).message;
        ctx.logger.warn(`llm-edgerouter: could not mint an allowance — ${message}`);
        await settingsCtx.settings
          .update(NS, { delegationStatus: `mint failed — ${message}` })
          .catch(() => {});
      }
    };

    /**
     * Empties an allowance and everything beneath it, in both places it lives.
     *
     * The authority's revocation is immediate and private: the node is emptied,
     * so the capability buys nothing from this process. The registry's is
     * slower and public: clearing the subregistry pointer stops the name — and
     * every name beneath it — resolving, which any observer can verify and
     * which survives this process being restarted, replaced, or disbelieved.
     *
     * Both, in that order. The budget is what actually stops the spending, so
     * it goes first and a failure to reach Sepolia afterwards leaves the
     * allowance revoked rather than half-revoked. The on-chain half is reported
     * separately for the same reason: a user who is told "revoked" should not
     * have to wonder which kind.
     */
    const runRevoke = async (node: string): Promise<void> => {
      try {
        await settingsCtx.settings.update(NS, { delegateRevoke: '' });
        if (!delegation) throw new Error('delegation is not running');

        const recovered = await delegation.revoke(node);
        reportTree();

        let onChain = '';
        const now = current();
        if (now.ensNames && node.endsWith('.eth')) {
          try {
            const { openEnsSigner, revokeAgentName, registryOf, createEnsClient } = await import(
              '../../ens/src/index'
            );
            const ensSigner = openEnsSigner();
            const [label, ...rest] = node.split('.');
            const parentRegistry = await registryOf(ensSigner.public, rest.join('.'));
            if (!parentRegistry) throw new Error('its parent owns no registry');

            /*
              The resolver is looked up rather than assumed: clearing the
              address record is the write that actually revokes, and it has to
              land on whichever resolver this name is served by.
            */
            const resolver = await createEnsClient().resolverOf(node);

            const hash = await revokeAgentName(
              { public: ensSigner.public, wallet: ensSigner.wallet },
              {
                parentRegistry,
                label: label!,
                name: node,
                ...(resolver ? { resolver } : {}),
              },
            );
            onChain = `, and the name was withdrawn on chain (${hash.slice(0, 12)}…)`;
            ctx.logger.info(`llm-edgerouter: withdrew ${node} on chain — ${hash}`);
          } catch (error) {
            /*
              Reported rather than raised. The money is already stopped; failing
              the whole revocation because a chain was unreachable would be
              telling the user nothing happened when the important half did.
            */
            onChain = `, but the name could not be withdrawn on chain: ${(error as Error).message}`;
            ctx.logger.warn(
              `llm-edgerouter: revoked ${node} locally but not on chain — ${(error as Error).message}`,
            );
          }
        }

        await settingsCtx.settings.update(NS, {
          delegationStatus: `revoked ${node}, recovering ${recovered.toString()}${onChain}`,
        });
      } catch (error) {
        const message = (error as Error).message;
        ctx.logger.warn(`llm-edgerouter: could not revoke ${node} — ${message}`);
        await settingsCtx.settings
          .update(NS, { delegationStatus: `revoke failed — ${message}` })
          .catch(() => {});
      }
    };

    /**
     * Moves USDC from the address into the Gateway balance.
     *
     * Cleared before the deposit rather than after, for the same reason
     * withdrawal is: a crash between the two leaves an unmade deposit rather
     * than an instruction that replays on the next start. A repeated deposit is
     * less alarming than a repeated withdrawal — it moves the user's money into
     * their own balance — but "the plugin did that twice" is not a sentence
     * worth having to explain either way.
     */
    const runDeposit = async (amount: string): Promise<void> => {
      try {
        await settingsCtx.settings.update(NS, { depositAmount: '' });

        if (!evmWallet) throw new Error('this provider is not paying from a local EVM wallet');
        if (!isGatewayNetwork(evmWallet.network)) {
          throw new Error(`${evmWallet.network} does not pay through Circle Gateway`);
        }
        if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
          throw new Error(`"${amount}" is not an amount of USDC`);
        }

        ctx.logger.info(`llm-edgerouter: depositing ${amount} USDC into the Gateway`);
        const deposited = await depositToGateway({
          privateKey: evmWallet.exportPrivateKey(),
          network: evmWallet.network,
          amount,
        });
        ctx.logger.info(`llm-edgerouter: deposited — ${deposited.hash}`);

        // The balance that decides "can pay" just changed, and nothing else
        // would notice: polling stops once funded.
        await checkGatewayFunding(false);
      } catch (error) {
        const message = (error as Error).message;
        ctx.logger.warn(`llm-edgerouter: the deposit failed — ${message}`);
        await settingsCtx.settings
          .update(NS, { walletStatus: `deposit failed — ${message}` })
          .catch(() => {});
      }
    };

    let withdrawing = false;
    const runWithdrawal = async (to: string): Promise<void> => {
      if (withdrawing) return;
      withdrawing = true;
      const network = current().network ?? DEFAULT_NETWORK;

      const finish = async (line: string) => {
        await settingsCtx.settings
          .update(NS, { withdrawStatus: line })
          .catch((error: unknown) =>
            ctx.logger.warn(`llm-edgerouter: could not report the withdrawal: ${(error as Error).message}`),
          );
      };

      try {
        // Cleared first, so this instruction cannot outlive the attempt.
        await settingsCtx.settings.update(NS, { withdrawTo: '' });

        if (!isWithdrawDestination(to, network)) {
          ctx.logger.warn(`llm-edgerouter: refused a withdrawal to "${to}" — not an address on ${network}`);
          await finish(`refused — "${to}" is not an address on ${network}`);
          return;
        }
        if (!wallet && !evmWallet) {
          await finish('refused — this provider is not paying from a local wallet');
          return;
        }

        ctx.logger.info(`llm-edgerouter: withdrawing everything to ${to}`);
        const swept = wallet ? await wallet.sweep(to) : await evmWallet!.sweep(to);
        const moved = formatAmount(network, swept.amountMinor);
        ctx.logger.info(`llm-edgerouter: withdrew ${moved} to ${to}`);
        await finish(`sent ${moved} to ${to}`);

        await settleBalance();
      } catch (error) {
        const message = (error as Error).message;
        ctx.logger.error(`llm-edgerouter: the withdrawal failed — ${message}`);
        await finish(`failed — ${message}`);
      } finally {
        withdrawing = false;
      }
    };

    chatReporter.attach((ensChatName, ensChats) => {
      void settingsCtx.settings
        .update(NS, { ensChatName, ensChats })
        .catch((error: unknown) =>
          ctx.logger.warn(
            `llm-edgerouter: could not report the chat name: ${(error as Error).message}`,
          ),
        );
    });

    nameReporter.attach((ensName, ensStatus) => {
      void settingsCtx.settings
        .update(NS, { ensName, ensStatus })
        .catch((error: unknown) =>
          ctx.logger.warn(
            `llm-edgerouter: could not report the ENS name into settings: ${(error as Error).message}`,
          ),
        );
    });

    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        const mint = current().delegateMint?.trim();
        if (mint) {
          void runMint(mint);
          return;
        }
        const revoke = current().delegateRevoke?.trim();
        if (revoke) {
          void runRevoke(revoke);
          return;
        }

        const deposit = current().depositAmount?.trim();
        if (deposit) {
          void runDeposit(deposit);
          return;
        }

        const to = current().withdrawTo?.trim();
        if (to) {
          void runWithdrawal(to);
          // Deliberately not restarting the payment source: nothing about the
          // wallet, network, or gate changed, and tearing the signer down
          // mid-withdrawal would only widen the window for a failed call.
          return;
        }
        /*
          Everything else resolves per request. The payment source does not: it
          holds a wallet, a poll, and possibly a connection to another process,
          so a changed network or source has to tear that down and build it
          again rather than be read afresh next call.
        */
        void start();
        // Turning naming on should not need a restart to take effect. Turning
        // it off leaves the name alone: it is registered on a public chain and
        // a settings toggle does not un-register anything.
        void claimName();
        void syncDelegation();
      },
    });
  });
}
