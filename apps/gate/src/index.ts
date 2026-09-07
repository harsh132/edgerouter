/**
 * The gate. A stateless Cloudflare Worker.
 *
 *   verify the capability  →  price the request  →  check the policy
 *   →  402 or accept payment  →  proxy upstream  →  settle
 *
 * No database, no session, no account. Everything needed to decide arrives in
 * the request: the capability is a signature chain the Worker recomputes from a
 * derived root key, and the payment is verified by a facilitator. Nothing is
 * remembered between requests, which is the property that lets this run at the
 * edge and the reason there is nothing here to breach.
 *
 * The route is OpenAI-compatible on purpose. An existing client points its base
 * URL here and passes its capability token where an API key would go, so
 * nothing in the caller has to know this protocol exists.
 */
import { permits, policyOf } from '../../../packages/core/src/caveat';
import { deserialize, verify, type Token } from '../../../packages/core/src/token';
import {
  HEADER,
  matchesQuote,
  parsePayment,
  paymentRequiredResponse,
  requirements,
  settlePayment,
  verifyPayment,
  base64,
} from './x402';
import { priceFor, MODELS } from './pricing';
import { deriveRootKey, type Env } from './env';
import { DEFAULT_POLICY, payerOf, recordFailure, recordSuccess, standing } from './ledger';
import { parseNetworks, selectNetwork } from './networks';

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Errors name the rule that fired and stop.
 *
 * Deliberately incurious: an agent that can enumerate the policy from its
 * refusals can be walked through it one rejection at a time by whoever is
 * injecting it, until it finds the gap.
 */
const refuse = (code: string, detail: string, status = 403): Response =>
  json({ error: { code, detail } }, status);

/**
 * Reads the capability out of the request.
 *
 * `Authorization: Bearer er_<base64>` — the Bearer slot because that is where
 * every OpenAI-compatible client already puts its key, and base64 because a
 * token is JSON and JSON does not belong in a header raw.
 */
const capabilityFrom = (request: Request): Token | null => {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const bearer = header.slice(7).trim();
  const encoded = bearer.startsWith('er_') ? bearer.slice(3) : bearer;

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  return deserialize(decoded);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      // Reports configuration presence, never values. A health endpoint that
      // leaks which secrets exist is a reconnaissance endpoint.
      return json({
        ok: true,
        x402: Boolean(env.FACILITATOR_URL),
        upstream: Boolean(env.OPENROUTER_API_KEY),
        networks: [...parseNetworks(env.NETWORKS).keys()],
      });
    }

    if (url.pathname === '/v1/models') {
      // Free: a price list nobody should have to pay to read.
      return json({
        object: 'list',
        data: MODELS.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: 'edgerouter',
          pricing: { minor_per_call: model.minorPerCall.toString(), currency: 'USDC' },
        })),
      });
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleCompletion(request, env);
    }

    return refuse('not_found', 'no such route', 404);
  },
} satisfies ExportedHandler<Env>;

const handleCompletion = async (request: Request, env: Env): Promise<Response> => {
  /*
    Fail closed on configuration. A gate with no facilitator cannot verify that
    anyone paid, and the safe reading of "payment checking is not configured" is
    not "serve everything for free".
  */
  if (!env.FACILITATOR_URL) {
    return refuse('unconfigured', 'no facilitator configured; paid routes are closed', 503);
  }
  if (!env.SERVICE_SECRET) {
    return refuse('unconfigured', 'no service secret configured', 503);
  }

  const token = capabilityFrom(request);
  if (!token) {
    return refuse('no_capability', 'send a capability as Authorization: Bearer er_<token>', 401);
  }

  const verified = await verify(await deriveRootKey(env.SERVICE_SECRET, token.root), token.root, token);
  if (!verified.ok) {
    return refuse('bad_capability', `capability failed verification (${verified.reason})`, 401);
  }

  let body: { model?: unknown };
  try {
    body = (await request.clone().json()) as { model?: unknown };
  } catch {
    return refuse('bad_request', 'body must be JSON', 400);
  }

  const model = typeof body.model === 'string' ? body.model : null;
  if (!model) return refuse('bad_request', 'model is required', 400);

  const price = priceFor(model);
  if (price === null) return refuse('unknown_model', `no price for ${model}`, 400);

  /*
    The policy is checked before the 402, not after payment. Asking someone to
    pay for something we were always going to refuse would need a refund path,
    and a refund path is state.
  */
  const host = new URL(request.url).host;
  const decision = permits(policyOf(token.caveats), {
    amountMinor: price,
    host,
    now: Date.now(),
  });
  if (!decision.ok) {
    return refuse(`policy_${decision.rule}`, decision.detail, 403);
  }

  /*
    One network per quote: x402 v2 carries a single `paymentRequired` rather
    than v1's list of accepted options. An unrecognised request is refused
    rather than quoted on the default — a client that asked for Hedera and
    received a Base quote would sign something it cannot settle.
  */
  const networks = parseNetworks(env.NETWORKS);
  if (networks.size === 0) {
    return refuse('unconfigured', 'no payment networks configured', 503);
  }
  const chosen = selectNetwork(networks, request, env.DEFAULT_NETWORK);
  if (!chosen.ok) {
    return refuse(
      'unsupported_network',
      `no configured network for ${chosen.asked}; try one of ${[...networks.keys()].join(', ')}`,
      400,
    );
  }
  const network = chosen.network;

  const reqs = requirements({
    request,
    amountMinor: price,
    description: `edgerouter inference: ${model}`,
    network,
  });

  const payment = parsePayment(request.headers.get(HEADER.signature));
  if (!payment) return paymentRequiredResponse(reqs);

  /*
    Debt is checked here — after a payment has been offered, before anything is
    spent on this caller's behalf. Checking it earlier would refuse a quote to
    someone who has not yet had a chance to settle; checking it later would mean
    the upstream call is already paid for.
  */
  /*
    Telemetry, not a control. Recorded because knowing the unsettled rate is how
    a facilitator problem gets noticed, but it defends nothing: both a payer
    address and a capability can be rotated for the price of a signature, so a
    determined caller simply arrives as somebody new. The actual defence is
    escrow — see the batch-settlement note in docs/PROJECTS.md.

    On Hedera the payer is inside a serialized transaction we do not decode, so
    only the capability axis is recorded there.
  */
  const payer = network.kind === 'evm' ? payerOf(payment.payload) : null;
  const ids = { payer, capability: token.node };

  if (env.DEBT) {
    const good = await standing(env.DEBT, DEFAULT_POLICY, ids);
    if (!good.ok) {
      return refuse(
        'unsettled_debt',
        `earlier calls were served but never settled (${good.debt.failures} failures, ${good.debt.owedMinor} owed)`,
        402,
      );
    }
  }

  /*
    Checked before the facilitator sees it. A facilitator verifies that a
    signature is valid for the terms inside the payload — not that those terms
    are the ones we quoted. Without this, a correctly signed payment for one
    cent settles cleanly against a request priced at a dollar.
  */
  if (!matchesQuote(payment, reqs, network.kind)) {
    return refuse('payment_mismatch', 'payment terms do not match the quote', 402);
  }

  const facilitator = { url: env.FACILITATOR_URL, ...(env.FACILITATOR_API_KEY ? { apiKey: env.FACILITATOR_API_KEY } : {}) };

  const checked = await verifyPayment(facilitator, payment, reqs);
  if (!checked.ok) return refuse('payment_invalid', checked.reason, 402);

  const upstream = await callUpstream(request, env);
  if (!upstream.ok) {
    // Nothing was settled, so nothing is owed. Verify-before, settle-after
    // means an upstream failure costs the operator a call and the user nothing.
    return refuse('upstream_failed', upstream.reason, 502);
  }

  const settled = await settlePayment(facilitator, payment, reqs);
  if (!settled.ok) {
    /*
      The answer exists and the payer authorised the charge; settlement failed
      afterwards. It is served anyway — withholding a paid-for answer because
      our accounting had a bad minute is the wrong way round — but the loss is
      recorded so the same caller cannot repeat it indefinitely.
    */
    console.error('settlement failed after successful upstream call', settled.reason);
    if (env.DEBT) await recordFailure(env.DEBT, DEFAULT_POLICY, ids, price);
  } else if (env.DEBT) {
    await recordSuccess(env.DEBT, DEFAULT_POLICY, ids);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.contentType,
      [HEADER.response]: base64(JSON.stringify(settled.ok ? settled.body : { settled: false })),
    },
  });
};

type Upstream =
  | { ok: true; body: string; contentType: string }
  | { ok: false; reason: string };

const callUpstream = async (request: Request, env: Env): Promise<Upstream> => {
  if (!env.OPENROUTER_API_KEY) return { ok: false, reason: 'no upstream key configured' };

  const body = await request.text();
  let response: Response;
  try {
    response = await fetch(env.UPSTREAM_URL ?? 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  const text = await response.text();
  if (!response.ok) return { ok: false, reason: `upstream ${response.status}` };

  return {
    ok: true,
    body: text,
    contentType: response.headers.get('content-type') ?? 'application/json',
  };
};
