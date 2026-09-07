/**
 * `llm-edgerouter` — a DeepSeek Harness provider that pays for its own tokens.
 *
 * Install it, point it at a gate, give it a capability and a wallet, and the
 * harness buys inference per call over x402. There is no account anywhere.
 *
 * Why a provider plugin rather than configuration: the harness can already
 * reach an OpenAI-compatible endpoint through a hand-declared `llm-pi-ai`
 * route, and doing that against edgerouter works right up to the point the gate
 * answers `402 Payment Required` — which nothing in the harness knows how to
 * pay. pi-ai's `transport` option selects SSE or WebSocket, not a request
 * implementation, so there is no seam to hand it a paying fetch. Owning the
 * adapter is what puts `payAndFetch` in the request path.
 *
 * @module @edgerouter/dsh
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
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
/** One HBAR in tinybars. A per-call ceiling, not a budget. */
const DEFAULT_MAX_AMOUNT = '100000000';
const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface Config {
  /** Gate base URL, e.g. `https://gate.edgerouter.io`. */
  baseURL: string;
  /** Environment variable holding the capability token (`er_…`). */
  capabilityEnv?: string;
  /** Hedera account the money leaves. Public, so it is configured directly. */
  accountId?: string;
  /** Environment variable holding the payer's private key. Never inline. */
  privateKeyEnv?: string;
  /**
   * Ceiling for one call, in the asset's smallest unit — tinybars on Hedera.
   *
   * A string because it is a bigint and JSON has no such thing, and mandatory
   * in effect (it has a default) because an uncapped payment client signs
   * whatever it is quoted.
   */
  maxAmount?: string;
  /** CAIP-2 network to pay on. */
  network?: string;
  /** Context capacity assumed when the gate does not say. */
  defaultContextWindow?: number;
}

export const Config: z<Config> = z.object({
  baseURL: z.string().required(),
  capabilityEnv: z.string().role('credential-ref').default(DEFAULT_CAPABILITY_ENV),
  accountId: z.string(),
  privateKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_ENV),
  maxAmount: z.string().default(DEFAULT_MAX_AMOUNT),
  network: z.string().default('hedera:testnet'),
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
  const maxAmount = resolveMaxAmount(config.maxAmount);

  const connection = () => ({
    baseURL: config.baseURL,
    capability: process.env[config.capabilityEnv ?? DEFAULT_CAPABILITY_ENV] ?? '',
    maxAmount,
    ...(config.network ? { network: config.network } : {}),
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
  });

  /*
    Built once and cached, because parsing a key is the expensive part and the
    account cannot change without a reconfiguration anyway. Read from the
    environment rather than the credentials seam for now — that seam is the
    better home and is the obvious next change; what matters today is that the
    key is never in a config file and never in a log.
  */
  let signer: PaymentSigner | undefined;
  let signerFailed = false;
  const resolveSigner = (): PaymentSigner | undefined => {
    if (signer || signerFailed) return signer;
    const accountId = config.accountId ?? process.env[DEFAULT_ACCOUNT_ENV];
    const privateKey = process.env[config.privateKeyEnv ?? DEFAULT_KEY_ENV];
    if (!accountId || !privateKey) return undefined;
    try {
      signer = hederaSigner({
        accountId,
        privateKey,
        ...(config.network ? { network: config.network } : {}),
      });
    } catch (error) {
      // Said once. A bad key fails every call, and repeating it per request
      // buries the reason under identical lines. The key is not in the message.
      signerFailed = true;
      ctx.logger.error(`llm-edgerouter: could not build a payment signer: ${(error as Error).message}`);
    }
    return signer;
  };

  /*
    A running total for the session. Kept here rather than in the adapter
    because it belongs to the plugin's lifetime, and printed on every call
    because the entire proposition is that the user is spending real money —
    the moment that becomes invisible, this is just a slower API key.
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
}
