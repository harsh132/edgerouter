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
 * This package is a *bundle*: `dsh.bundle.patch` in its manifest points at
 * `cordis.patch.yml`, which is what makes `dsh plugin add` insert it into a
 * profile's layer stack rather than merely installing it as a dependency.
 *
 * @module dsh-plugin-edgerouter
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
import { hederaSigner, formatHbar, type PaymentSigner } from '../../sdk/src/index';
import { EdgerouterAdapter, type Paid } from './adapter';

export { EdgerouterAdapter } from './adapter';
export type { Paid, EdgerouterAdapterOptions } from './adapter';
export * from './convert';

export const name = 'llm-edgerouter';
export const inject = ['llm'];

/** The one provider route this plugin owns. */
const PROVIDER = 'edgerouter';
const NS = 'llm-edgerouter';

const DEFAULT_CAPABILITY_ENV = 'EDGEROUTER_TOKEN';
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
/** One HBAR in tinybars. A per-call ceiling, not a budget. */
const DEFAULT_MAX_AMOUNT = '100000000';
const DEFAULT_NETWORK = 'hedera:testnet';
const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface Config {
  /** Gate base URL. Defaults to the public gate. */
  baseURL?: string;
  /** Environment variable holding an optional capability token (`er_…`). */
  capabilityEnv?: string;
  /** Hedera account the money leaves. Public, so it is configured directly. */
  accountId?: string;
  /** Environment variable holding the payer's private key. Never inline. */
  privateKeyEnv?: string;
  /**
   * Ceiling for one call, in the asset's smallest unit — tinybars on Hedera.
   *
   * A string because it is a bigint and JSON has no such thing, and always
   * present because an uncapped payment client signs whatever it is quoted.
   */
  maxAmount?: string;
  /** CAIP-2 network to pay on. */
  network?: string;
  /** Context capacity assumed when the gate does not say. */
  defaultContextWindow?: number;
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  capabilityEnv: z.string().role('credential-ref').default(DEFAULT_CAPABILITY_ENV),
  accountId: z.string(),
  privateKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_ENV),
  maxAmount: z.string().default(DEFAULT_MAX_AMOUNT),
  network: z.string().default(DEFAULT_NETWORK),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
});

/**
 * Reads and validates the per-call ceiling.
 *
 * Refused rather than defaulted when malformed: a cap that silently became
 * something else is not a cap, and the failure it prevents is expensive.
 */
export const resolveMaxAmount = (raw: string | undefined): bigint => {
  const text = (raw ?? DEFAULT_MAX_AMOUNT).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`llm-edgerouter: maxAmount must be a whole number of the smallest unit, got "${text}"`);
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
  let lastGoodMax = resolveMaxAmount(config.maxAmount);
  let complainedAboutMax = false;
  const maxAmount = (): bigint => {
    try {
      lastGoodMax = resolveMaxAmount(current().maxAmount);
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
      capability: process.env[now.capabilityEnv ?? DEFAULT_CAPABILITY_ENV] ?? '',
      maxAmount: maxAmount(),
      network: now.network ?? DEFAULT_NETWORK,
      defaultContextWindow: now.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    };
  };

  /*
    Cached against the facts that define it, so a settings change that moves the
    account or the network builds a new signer while an unrelated edit does not
    pay to parse a key again. Read from the environment rather than the
    credentials seam for now — that seam is the better home and is the obvious
    next change; what matters today is that the key is never in a config file
    and never in a log.
  */
  let cached: { key: string; signer: PaymentSigner } | undefined;
  let failedKey: string | undefined;
  const resolveSigner = (): PaymentSigner | undefined => {
    const now = current();
    const accountId = now.accountId ?? process.env[DEFAULT_ACCOUNT_ENV];
    const privateKey = process.env[now.privateKeyEnv ?? DEFAULT_KEY_ENV];
    const network = now.network ?? DEFAULT_NETWORK;
    if (!accountId || !privateKey) return undefined;

    const key = `${accountId}|${network}`;
    if (cached?.key === key) return cached.signer;
    if (failedKey === key) return undefined;

    try {
      const signer = hederaSigner({ accountId, privateKey, network });
      cached = { key, signer };
      failedKey = undefined;
      return signer;
    } catch (error) {
      // Said once per bad configuration. A bad key fails every call, and
      // repeating it per request buries the reason. The key is not in the message.
      failedKey = key;
      ctx.logger.error(`llm-edgerouter: could not build a payment signer: ${(error as Error).message}`);
      return undefined;
    }
  };

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
    const each = paid.network.startsWith('hedera:')
      ? `${formatHbar(paid.amount)} (total ${formatHbar(spent)} over ${calls})`
      : `${paid.amount} (total ${spent} over ${calls})`;
    ctx.logger.info(
      `paid ${each} for ${paid.model} — sign ${paid.signingMs}ms, call ${paid.requestMs}ms`
      + (paid.transaction ? ` — ${paid.transaction}` : ''),
    );
  };

  const adapter = new EdgerouterAdapter({ connection, signer: resolveSigner, onPaid });

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'edgerouter', settingsNs: NS, settingsPath: [] },
  ]);
  ctx.llm.registerAdapter([PROVIDER], adapter);

  /*
    Optional injection. The settings service is what makes the `llm-edgerouter:`
    section in a profile's settings file mean anything; without it the
    composition entry is the whole configuration, which is still a working
    plugin — just one you have to restart to reconfigure.
  */
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        // Everything else resolves per request; only the cached signer holds
        // state that a changed account or network must invalidate.
        cached = undefined;
        failedKey = undefined;
      },
    });
  });
}
