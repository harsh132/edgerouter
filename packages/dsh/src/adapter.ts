/**
 * The adapter: one model call, paid for on the way through.
 *
 * Everything unusual about this provider is in one line of `stream()` — the
 * request goes out through `payAndFetch` instead of `fetch`. A 402 comes back,
 * a transfer is signed, the request is retried, and the answer arrives. The
 * harness sees an ordinary provider.
 *
 * **Non-streaming, deliberately.** The gate reads its upstream with
 * `response.text()` before answering, so it cannot forward tokens as they
 * arrive; asking it for `stream: true` would buffer the whole SSE body and
 * deliver it in one piece, which is what a non-streaming request already does
 * with less machinery. If the gate learns to stream, this is the place that
 * changes — the chunk vocabulary already supports it.
 *
 * The cost of a call is reported through `onPaid`, because a provider that
 * silently spends money is not one anybody should install.
 */
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { PaymentRefused, payAndFetch, type PaymentSigner } from '../../sdk/src/index';
import { toChunks, toRequest, type OpenAiResponse } from './convert';

/** What a paid call cost, once it is known. */
export type Paid = {
  model: string;
  /** Smallest unit of the payment asset — tinybars on Hedera. */
  amount: bigint;
  network: string;
  /** Present when the gate reported a settlement. */
  transaction?: string;
  signingMs: number;
  requestMs: number;
};

export type EdgerouterAdapterOptions = {
  /** Resolved per request, so a changed setting reaches the next call. */
  connection: () => {
    baseURL: string;
    /** The capability token, in the `Authorization: Bearer` slot. */
    capability: string;
    /** Most this single call may cost, in the asset's smallest unit. */
    maxAmount: bigint;
    network?: string;
    defaultContextWindow: number;
  };
  /** Built once the payment credentials resolve; absent means unpaid calls only. */
  signer: () => PaymentSigner | undefined;
  onPaid?: (paid: Paid) => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

/**
 * Refusals that happen before signing, mapped to harness error codes.
 *
 * Each is a distinct thing for a user to fix, and collapsing them into one
 * "payment failed" is the difference between "raise your cap" and a shrug.
 */
const REFUSAL_CODES: Record<string, string> = {
  over_max_amount: 'PAYMENT_OVER_CAP',
  no_matching_network: 'PAYMENT_NETWORK_UNAVAILABLE',
  self_payment: 'PAYMENT_SELF',
  bad_quote: 'PAYMENT_BAD_QUOTE',
};

export class EdgerouterAdapter extends LlmAdapter {
  constructor(private readonly options: EdgerouterAdapterOptions) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'edgerouter' };
  }

  /**
   * The gate publishes its price list unauthenticated, so the catalog is read
   * from the service rather than hard-coded here — a model added at the gate
   * appears without shipping a new plugin version.
   *
   * Advisory by contract: a failure here returns nothing rather than throwing,
   * because an unreachable catalog must not stop a request naming a model the
   * caller already knows.
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const { baseURL } = this.options.connection();
    const doFetch = this.options.fetch ?? fetch;
    try {
      const response = await doFetch(new URL('/v1/models', baseURL), {
        headers: attributionHeaders(),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? [])
        .filter((model): model is { id: string } => typeof model.id === 'string')
        .map((model) => ({
          provider,
          id: model.id,
          name: model.id,
          inputModalities: ['text'] as const,
        }));
    } catch {
      return [];
    }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const { defaultContextWindow } = this.options.connection();
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: defaultContextWindow },
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.options.connection();
    const signer = this.options.signer();
    if (!signer) {
      throw new LlmError(
        'edgerouter: no payment signer; set the Hedera account id and private key for this provider',
        'MISSING_CREDENTIAL',
      );
    }

    const url = new URL('/v1/chat/completions', connection.baseURL).toString();
    const body = JSON.stringify(toRequest(options));

    let result;
    try {
      result = await payAndFetch(url, {
        signer,
        maxAmount: connection.maxAmount,
        ...(connection.network ? { network: connection.network } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            /*
              Omitted entirely when there is no capability, rather than sent
              empty. The gate is permissionless — no header means anonymous and
              is quoted a price like anyone else — but a present-and-unreadable
              header is a tampered capability and refused. `Bearer ` with
              nothing after it is the second of those, so sending one would turn
              "I have no token" into "my token is broken".
            */
            ...(connection.capability
              ? { authorization: `Bearer ${connection.capability}` }
              : {}),
            ...attributionHeaders(),
          },
          body,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      });
    } catch (error) {
      /*
        Thrown, not returned as a finish chunk. Nothing was served and nothing
        was paid: this is a transport-class failure, which the contract routes
        through a throw.
      */
      if (error instanceof PaymentRefused) {
        throw new LlmError(
          `edgerouter: ${error.message}`,
          REFUSAL_CODES[error.reason] ?? 'PAYMENT_REFUSED',
        );
      }
      if (options.signal?.aborted) {
        throw new LlmError('edgerouter: request aborted', 'ABORTED');
      }
      throw new LlmError(`edgerouter: ${(error as Error).message}`, 'TRANSPORT');
    }

    const { response, quote, settlement, signingMs, paidRequestMs } = result;

    if (!response.ok) {
      const detail = await response.text();
      throw new LlmError(
        `edgerouter: gate answered ${response.status}: ${detail.slice(0, 300)}`,
        response.status === 401 || response.status === 403 ? 'AUTH' : 'PROVIDER',
        { status: response.status },
      );
    }

    /*
      Reported before the body is parsed. The money moved whether or not the
      payload turns out to be something we can read, and a cost the user is not
      told about is the failure this plugin exists to avoid.
    */
    if (quote && this.options.onPaid) {
      const transaction = settlement?.transaction ?? settlement?.transactionId;
      this.options.onPaid({
        model: options.model,
        amount: BigInt(quote.amount),
        network: quote.network,
        ...(typeof transaction === 'string' ? { transaction } : {}),
        signingMs,
        requestMs: paidRequestMs,
      });
    }

    let parsed: OpenAiResponse;
    try {
      parsed = (await response.json()) as OpenAiResponse;
    } catch {
      throw new LlmError('edgerouter: the gate returned a body that was not JSON', 'PROVIDER');
    }

    yield* toChunks(parsed);
  }
}
