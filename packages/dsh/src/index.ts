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
  type EvmWallet,
  type LocalWallet,
  type PaymentSigner,
} from '../../sdk/src/index';
import { EdgerouterAdapter, type Paid } from './adapter';

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
});

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
          `fund ${short(wallet.evmAddress)}`,
        );
        if (announce) {
          ctx.logger.info(`llm-edgerouter: send hbar to ${wallet.evmAddress} to start paying`);
        }
        return;
      }
      const first = signer === undefined;
      signer = wallet.signer();
      publish(
        wallet.evmAddress,
        `ready — ${funding.accountId} holds ${formatAmount(wallet.network, funding.balanceMinor)}`,
        formatAmount(wallet.network, funding.balanceMinor),
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
    Two ways of saying the same thing, because neither reaches everyone.

    `toSettings` writes the address into the settings section, which is where it
    belongs and is also where Desktop declines to render it: the Models pane
    treats a provider's section as an endpoint-and-key profile, finds no field
    it recognises, and prints "other fields live in settings.yaml". The value is
    still there, still correct, and reachable from the button in that same
    dialog — but it is not on screen.

    `toDirectory` puts it in the provider's display name, which is the one
    string in that pane a plugin controls. A name is a strange place for a
    balance, and it is the difference between a user seeing an address and a
    user being told to go and find a YAML file.
  */
  let toSettings: (address: string, status: string) => void = () => {};
  let published = '';

  /**
   * The same, for an EVM chain.
   *
   * Separate because the state it reports is different, not because the code
   * would not compress. There is no "account does not exist yet" here — an EVM
   * address always exists — so the only question is whether anyone has sent it
   * the token the gate quotes, and the message says exactly that.
   */
  const checkEvmFunding = async (announce: boolean): Promise<void> => {
    if (!evmWallet) return;
    try {
      const funding = await evmWallet.refresh();
      if (!funding.canPay) {
        signer = undefined;
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
          `fund ${short(evmWallet.address)}`,
        );
        if (announce) {
          ctx.logger.info(`llm-edgerouter: send USDC to ${evmWallet.address} to start paying`);
        }
        return;
      }
      const first = signer === undefined;
      signer = evmWallet.signer();
      publish(
        evmWallet.address,
        `ready — holds ${formatAmount(evmWallet.network, funding.tokenMinor)}`,
        formatAmount(evmWallet.network, funding.tokenMinor),
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
  (ctx as unknown as { effect(run: () => () => void): unknown }).effect(() => () => clearPolling());

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
    const each =
      `${formatAmount(paid.network, paid.amount)}` +
      ` (total ${formatAmount(paid.network, spent)} over ${calls})`;
    ctx.logger.info(
      `paid ${each} for ${paid.model} — sign ${paid.signingMs}ms, call ${paid.requestMs}ms` +
        (paid.transaction ? ` — ${paid.transaction}` : ''),
    );
  };

  const adapter = new EdgerouterAdapter({
    connection,
    signer: () => signer,
    unavailableReason: () => unavailable,
    onPaid,
  });

  const directory = ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'edgerouter', settingsNs: NS, settingsPath: [] },
  ]);

  /** `0x1234…cdef`. An address nobody can read is not worth the width. */
  const short = (address: string): string =>
    address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;

  /**
   * Says where the money goes, everywhere that will listen.
   *
   * Guarded against repeating itself, because a settings write emits a change,
   * a change restarts the payment source, and the payment source publishes —
   * unguarded, that is a loop which looks like a working feature until the log
   * fills up.
   */
  const publish = (address: string, status: string, short_: string) => {
    const line = `${address}|${status}`;
    if (line === published) return;
    published = line;

    try {
      directory.replace([
        { provider: PROVIDER, displayName: `edgerouter · ${short_}`, settingsNs: NS, settingsPath: [] },
      ]);
    } catch (error) {
      // A rejected rename is cosmetic. It must not take a working provider down.
      ctx.logger.warn(`llm-edgerouter: could not update the display name: ${(error as Error).message}`);
    }

    toSettings(address, status);
  };

  /*
    Started last, after everything it publishes into exists.

    It would in fact survive being started earlier — the first thing it awaits
    is a network read, so `apply` returns long before anything is published —
    but that is an accident of where an await happens to sit, and a later edit
    that moves one would turn it into a use-before-declaration at runtime.
  */
  void start();
  ctx.llm.registerAdapter([PROVIDER], adapter);

  /*
    Optional injection. The settings service is what makes the `llm-edgerouter:`
    section in a profile's settings file mean anything; without it the
    composition entry is the whole configuration, which is still a working
    plugin — just one you have to restart to reconfigure.
  */
  ctx.inject(['settings'], (settingsCtx) => {
    toSettings = (address, status) => {
      /*
        Fire and forget, and a failure is logged rather than raised. This is a
        convenience — the address is also in the logs and in the refusal a call
        would get — so a settings service that refuses a write must not take the
        provider down with it.
      */
      void settingsCtx.settings
        .update(NS, { walletAddress: address, walletStatus: status })
        .catch((error: unknown) => {
          ctx.logger.warn(
            `llm-edgerouter: could not report the wallet address into settings: ${(error as Error).message}`,
          );
        });
    };

    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        /*
          Everything else resolves per request. The payment source does not: it
          holds a wallet, a poll, and possibly a connection to another process,
          so a changed network or source has to tear that down and build it
          again rather than be read afresh next call.
        */
        void start();
      },
    });
  });
}
