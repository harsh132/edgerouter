/**
 * The gate. A stateless Cloudflare Worker.
 *
 *   price the request  →  402 or accept payment  →  settle  →  proxy upstream
 *
 * Permissionless. There is no signup, no account, and no key to be issued:
 * anyone who can pay is served, which is the whole point of doing this over
 * x402 rather than over an API key. A capability token may be presented and
 * then narrows what the request may do, but its absence is not an error.
 *
 * Settlement happens BEFORE the upstream call. That ordering is what makes
 * anonymity affordable: nothing is spent on a caller's behalf until their money
 * has actually moved, so there is no credit to extend and therefore no identity
 * to check. It costs nothing in latency, because settlement was always inside
 * the critical path — this only changes what it is sequenced against.
 *
 * No database, no session, no account. Everything needed to decide arrives in
 * the request, and nothing is remembered between requests — the property that
 * lets this run at the edge and the reason there is nothing here to breach.
 *
 * The route is OpenAI-compatible on purpose, so an existing client points its
 * base URL here and nothing in the caller has to know this protocol exists.
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

  /*
    Optional, and the distinction between "absent" and "invalid" is the whole
    of the access model.

    Absent means anonymous: the caller gets the default policy and pays like
    anyone else. Present but unverifiable is an error, not a downgrade —
    silently serving a request whose capability failed verification would mean a
    tampered token buys exactly what no token buys, and nobody would ever learn
    their delegation had stopped working.
  */
  const bearer = request.headers.get('authorization');
  const token = capabilityFrom(request);
  if (bearer && !token) {
    return refuse('bad_capability', 'the Authorization header is not a readable capability', 401);
  }
  if (token) {
    /*
      Only capabilities need the secret, so it is checked here rather than at
      the top. A gate with no service secret still serves anonymous paid
      requests perfectly well — it simply cannot verify a delegation, and
      saying so beats refusing everyone.
    */
    if (!env.SERVICE_SECRET) {
      return refuse('unconfigured', 'this gate cannot verify capabilities; omit yours to pay directly', 503);
    }
    const verified = await verify(
      await deriveRootKey(env.SERVICE_SECRET, token.root),
      token.root,
      token,
    );
    if (!verified.ok) {
      return refuse('bad_capability', `capability failed verification (${verified.reason})`, 401);
    }
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
  if (token) {
    const host = new URL(request.url).host;
    const decision = permits(policyOf(token.caveats), {
      amountMinor: price,
      host,
      now: Date.now(),
    });
    if (!decision.ok) {
      return refuse(`policy_${decision.rule}`, decision.detail, 403);
    }
  }

  /*
    One network per quote. The 402 body could carry several in `accepts`, but
    an unrecognised request is refused rather than quoted on the default — a
    client that asked for Hedera and received a Base quote would sign something
    it cannot settle.
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
    Checked before the facilitator sees it. A facilitator verifies that a
    signature is valid for the terms inside the payload — not that those terms
    are the ones we quoted. Without this, a correctly signed payment for one
    cent settles cleanly against a request priced at a dollar.
  */
  if (!matchesQuote(payment, reqs, network.kind)) {
    return refuse('payment_mismatch', 'payment terms do not match the quote', 402);
  }

  const facilitator = { url: env.FACILITATOR_URL, ...(env.FACILITATOR_API_KEY ? { apiKey: env.FACILITATOR_API_KEY } : {}) };

  /*
    Three timings, logged rather than returned. Which of the three dominates
    decides whether batching is worth building: settlement latency is the cost
    batching removes, and if the upstream dominates instead there is nothing to
    win. Guessing at that split from a single end-to-end number is how the wrong
    thing gets optimised.
  */
  const timing = { verifyMs: 0, upstreamMs: 0, settleMs: 0 };

  const verifyStarted = Date.now();
  const checked = await verifyPayment(facilitator, payment, reqs);
  timing.verifyMs = Date.now() - verifyStarted;
  if (!checked.ok) return refuse('payment_invalid', checked.reason, 402);

  /*
    Settled before the upstream call, and this is the ordering the whole access
    model rests on.

    Settling afterwards would mean serving first and hoping the money lands —
    extending credit. Credit needs an identity to extend it to, an identity has
    to be worth something to be worth checking, and the only identity in this
    request that cannot be minted for free is a capability we issue. Requiring
    one is exactly the signup this service exists to not have. So: no credit,
    no identity, no signup.

    It is not slower. Settlement was always inside the critical path before the
    response; this changes what it is sequenced against, not how much of it
    there is.

    The cost is real but small and lands on the right party: if the upstream
    fails after settlement, the caller has paid for an answer they did not get.
    That is one call, at a price they agreed to, and it is disclosed below —
    against an unbounded loss to anyone willing to make wallets faster than we
    can refuse them.
  */
  const settleStarted = Date.now();
  const settled = await settlePayment(facilitator, payment, reqs);
  timing.settleMs = Date.now() - settleStarted;
  if (!settled.ok) {
    // Nothing has been spent on this caller's behalf, so a failed settlement
    // costs nobody anything. It is simply not a paid request.
    console.error('settlement failed before the upstream call', settled.reason);
    return refuse('payment_unsettled', `payment did not settle: ${settled.reason}`, 402);
  }

  const upstreamStarted = Date.now();
  const upstream = await callUpstream(request, env);
  timing.upstreamMs = Date.now() - upstreamStarted;
  console.log(
    `x402 ${network.id} verify=${timing.verifyMs}ms settle=${timing.settleMs}ms upstream=${timing.upstreamMs}ms`,
  );

  if (!upstream.ok) {
    /*
      Paid for, and undeliverable. Reported with the settlement attached rather
      than as a bare 502, so the caller can see what they were charged and
      prove it — the only remedy a stateless service can offer is an honest
      receipt.
    */
    console.error('upstream failed after settlement', upstream.reason);
    return json(
      {
        error: {
          code: 'upstream_failed_after_payment',
          detail: `payment settled but the upstream call failed: ${upstream.reason}`,
        },
      },
      502,
      { [HEADER.response]: base64(JSON.stringify(settled.body)) },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.contentType,
      [HEADER.response]: base64(JSON.stringify(settled.body)),
    },
  });
};

type Upstream =
  | { ok: true; body: string; contentType: string }
  | { ok: false; reason: string };

/**
 * Upstream statuses worth trying again.
 *
 * Rate limits and gateway errors are the upstream saying "not now" rather than
 * "no". Everything else — a bad model id, a malformed body, an auth failure —
 * will fail identically on a second attempt, and retrying it would only make
 * the caller wait longer for the same answer.
 */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const ATTEMPTS = 3;

/**
 * Calls the upstream, retrying the failures that are worth retrying.
 *
 * This matters more than it looks, because settlement happens first: an
 * upstream failure now falls on a caller who has already paid. Retrying does
 * not remove that risk, but it removes the most common cause of it — a
 * transient 429 — and the alternative to spending a second or two here is
 * charging someone for nothing.
 *
 * The body is read once. A Request body is a stream and can only be consumed
 * once, so re-reading it per attempt would send an empty second request.
 */
const callUpstream = async (request: Request, env: Env): Promise<Upstream> => {
  if (!env.OPENROUTER_API_KEY) return { ok: false, reason: 'no upstream key configured' };

  const body = await request.text();
  const url = env.UPSTREAM_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
  let last = 'upstream never answered';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      // A transport failure is by nature transient; the request may not even
      // have arrived.
      last = (error as Error).message;
      if (attempt < ATTEMPTS) {
        await sleep(attempt);
        continue;
      }
      return { ok: false, reason: last };
    }

    const text = await response.text();
    if (response.ok) {
      return {
        ok: true,
        body: text,
        contentType: response.headers.get('content-type') ?? 'application/json',
      };
    }

    last = `upstream ${response.status}`;
    if (!RETRYABLE.has(response.status) || attempt === ATTEMPTS) {
      return { ok: false, reason: last };
    }
    console.warn(`upstream ${response.status}, retrying (attempt ${attempt} of ${ATTEMPTS})`);
    await sleep(attempt, response.headers.get('retry-after'));
  }

  return { ok: false, reason: last };
};

/**
 * Backs off between attempts, honouring `Retry-After` when the upstream sends
 * a usable one. Capped, because the caller is waiting and a Worker has a
 * lifetime — a header asking for a minute is information, not an instruction.
 */
const sleep = (attempt: number, retryAfter?: string | null): Promise<void> => {
  const asked = retryAfter ? Number(retryAfter) * 1000 : NaN;
  const backoff = 400 * 2 ** (attempt - 1);
  const wait = Math.min(Number.isFinite(asked) && asked > 0 ? asked : backoff, 4_000);
  return new Promise((resolve) => setTimeout(resolve, wait));
};
