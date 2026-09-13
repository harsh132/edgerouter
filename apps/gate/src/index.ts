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
import { chargeFor, modelFor, MODELS, type Model } from './pricing';
import { deriveRootKey, type Env } from './env';
import { isEvmAddress, parseNetworks, sameIdentifier, selectNetwork, type NetworkConfig } from './networks';
import { UsageScanner, usageFromJson } from './meter';
import type { Settled } from './tab';
import {
  TAB_HEADER,
  decodeVoucher,
  encodeReceipt,
  receiptComment,
  recoverVoucherSigner,
  type SignedVoucher,
} from '../../../packages/sdk/src/tab/voucher';

/*
  Re-exported because Wrangler finds a Durable Object class by name on the
  Worker's main module. Declaring the binding without this deploys a Worker
  whose tabs fail on first use rather than at deploy.
*/
export { Tab } from './tab';

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
        /*
          Where a tab can be kept, and whom a voucher pays. A voucher signs the
          gate's `payTo` so it cannot be spent at another gate, which means a
          client has to learn it before its first call rather than from a 402
          it would never receive.
        */
        tabs: env.TAB
          ? [...parseNetworks(env.NETWORKS).values()]
              .filter((network) => network.kind === 'gateway')
              .map((network) => ({
                network: network.id,
                payTo: network.payTo,
                unitsPerUsdMinor: network.unitsPerUsdMinor.toString(),
              }))
          : [],
        data: MODELS.map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: 'edgerouter',
          /*
            Both ways a call can be paid for. `minor_per_call` is what an
            up-front x402 payment is charged; a tab is charged what the call
            actually cost, priced per million tokens, and never more than
            `tab_reserve_minor`.
          */
          pricing: {
            minor_per_call: model.flatMinor.toString(),
            input_minor_per_million: model.inputPerMillion.toString(),
            output_minor_per_million: model.outputPerMillion.toString(),
            tab_reserve_minor: model.reserveMinor.toString(),
            currency: 'USDC',
          },
        })),
      });
    }

    if (url.pathname === '/v1/tab/topup' && request.method === 'POST') {
      return handleTopup(request, env);
    }

    if (url.pathname === '/v1/tab' && request.method === 'GET') {
      const found = tabFor(request, env);
      if (!found.ok) return found.response;
      return json({
        network: found.network.id,
        payer: found.payer,
        balanceMinor: await found.tab.balance(),
      });
    }

    const voucherPath = /^\/v1\/tab\/vouchers\/(0x[0-9a-fA-F]{64})$/.exec(url.pathname);
    if (voucherPath && request.method === 'GET') {
      const found = tabFor(request, env);
      if (!found.ok) return found.response;
      return json({ nonce: voucherPath[1], ...(await found.tab.voucher(voucherPath[1]!.toLowerCase())) });
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleCompletion(request, env, ctx);
    }

    return refuse('not_found', 'no such route', 404);
  },
} satisfies ExportedHandler<Env>;

const handleCompletion = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
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

  const priced = modelFor(model);
  if (priced === null) return refuse('unknown_model', `no price for ${model}`, 400);
  const price = priced.flatMinor;

  /*
    A voucher means this call is paid from a tab rather than by a payment of
    its own. Present but unreadable is refused rather than ignored, for the
    same reason a bad capability is: falling through to a 402 would ask a
    client that believed it had already paid to pay again.
  */
  const voucherHeader = request.headers.get(TAB_HEADER.voucher);
  const voucher = decodeVoucher(voucherHeader);
  if (voucherHeader && !voucher) {
    return refuse('bad_voucher', `the ${TAB_HEADER.voucher} header is not a readable voucher`, 400);
  }

  /*
    The policy is checked before the 402, not after payment. Asking someone to
    pay for something we were always going to refuse would need a refund path,
    and a refund path is state.
  */
  if (token) {
    const host = new URL(request.url).host;
    const decision = permits(policyOf(token.caveats), {
      /*
        A tab call is held to the most it can be charged, not to what it will
        probably cost. A capability's per-call ceiling is a promise about the
        worst case, and the reserve is the worst case.
      */
      amountMinor: voucher ? priced.reserveMinor : price,
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

  if (voucher) return handleTabCompletion(request, env, ctx, network, priced, voucher);

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

  /*
    Per network, falling back to the gate's default.

    No facilitator settles every chain, and the ones that overlap do not
    overlap completely — so a single global facilitator caps what this gate can
    accept at that facilitator's own coverage. Naming one per network is what
    lets Hedera settle through the facilitator that does Hedera well while an
    EVM chain settles through one that does not do Hedera at all.
  */
  const facilitator = {
    url: network.facilitatorUrl ?? env.FACILITATOR_URL,
    ...(env.FACILITATOR_API_KEY ? { apiKey: env.FACILITATOR_API_KEY } : {}),
  };

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

  /*
    Streamed through. The settlement receipt rides in a header, which is sent
    before the first byte of body — so a caller reading deltas has proof of
    payment in hand before the answer starts, not after it ends.

    The cost of streaming is stated rather than hidden: once the status line is
    written, a mid-stream upstream failure cannot become a 502. It arrives as a
    truncated body, because there is no way to un-send a 200. Failures *before*
    the first byte still get the receipt-bearing error below.
  */
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.contentType,
      [HEADER.response]: base64(JSON.stringify(settled.body)),
    },
  });
};

/* ------------------------------------------------------------------- tabs */

/*
  Top-up bounds, in USD minor units. The floor keeps a top-up above the price
  of the reserve it exists to cover; the cap is the most this gate will hold
  for anyone, which is also the most anyone can lose to it.
*/
const TOPUP_MIN = 10_000n; // $0.01
const TOPUP_DEFAULT = 100_000n; // $0.10
const TOPUP_MAX = 5_000_000n; // $5.00

const encoder = new TextEncoder();

type FoundTab =
  | {
      ok: true;
      network: Extract<NetworkConfig, { kind: 'gateway' }>;
      payer: string;
      tab: DurableObjectStub<import('./tab').Tab>;
    }
  | { ok: false; response: Response };

/**
 * The tab a request is about, from `?payer=` and the network it names.
 *
 * Tabs are kept on Gateway networks only. Topping one up is a payment, and the
 * only network here where a payment small enough to be worth prepaying settles
 * without a transaction per payment is Gateway — elsewhere a top-up would cost
 * gas on the way in and defeat the point.
 */
const tabFor = (request: Request, env: Env, payerOverride?: string): FoundTab => {
  if (!env.TAB) {
    return { ok: false, response: refuse('tab_unavailable', 'this gate keeps no tabs', 503) };
  }
  const chosen = selectNetwork(parseNetworks(env.NETWORKS), request, env.DEFAULT_NETWORK);
  if (!chosen.ok) {
    return { ok: false, response: refuse('unsupported_network', `no configured network for ${chosen.asked}`, 400) };
  }
  if (chosen.network.kind !== 'gateway') {
    return {
      ok: false,
      response: refuse('tab_unsupported_network', `tabs are kept on Gateway networks; ${chosen.network.id} is not one`, 400),
    };
  }
  const payer = payerOverride ?? new URL(request.url).searchParams.get('payer') ?? '';
  if (!isEvmAddress(payer)) {
    return { ok: false, response: refuse('bad_request', 'payer must be a 0x address', 400) };
  }
  return {
    ok: true,
    network: chosen.network,
    payer: payer.toLowerCase(),
    tab: env.TAB.getByName(`${chosen.network.id}:${payer.toLowerCase()}`),
  };
};

/**
 * Tops a tab up with an ordinary x402 payment.
 *
 * The same verify-then-settle a call is paid with, and the credit happens only
 * once settlement has succeeded — so there is never a balance here that was not
 * paid for. The payer is read out of the authorization that settled rather than
 * from anything the request asserts: whoever signed the money owns the tab it
 * bought.
 */
const handleTopup = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const asked = url.searchParams.get('amount');
  let amountMinor = TOPUP_DEFAULT;
  if (asked !== null) {
    if (!/^\d+$/.test(asked)) return refuse('bad_request', 'amount must be whole USD minor units', 400);
    amountMinor = BigInt(asked);
  }
  if (amountMinor < TOPUP_MIN || amountMinor > TOPUP_MAX) {
    return refuse('bad_request', `a top-up is between ${TOPUP_MIN} and ${TOPUP_MAX} USD minor units`, 400);
  }

  if (!env.TAB) return refuse('tab_unavailable', 'this gate keeps no tabs', 503);
  const chosen = selectNetwork(parseNetworks(env.NETWORKS), request, env.DEFAULT_NETWORK);
  if (!chosen.ok) return refuse('unsupported_network', `no configured network for ${chosen.asked}`, 400);
  const network = chosen.network;
  if (network.kind !== 'gateway') {
    return refuse('tab_unsupported_network', `tabs are kept on Gateway networks; ${network.id} is not one`, 400);
  }

  const reqs = requirements({
    request,
    amountMinor,
    description: 'edgerouter tab top-up',
    network,
  });

  const payment = parsePayment(request.headers.get(HEADER.signature));
  if (!payment) return paymentRequiredResponse(reqs);
  if (!matchesQuote(payment, reqs, network.kind)) {
    return refuse('payment_mismatch', 'payment terms do not match the quote', 402);
  }

  const authorization = payment.payload.authorization as Record<string, unknown> | undefined;
  const from = authorization?.from;
  const nonce = authorization?.nonce;
  const value = authorization?.value;
  if (typeof from !== 'string' || !isEvmAddress(from) || typeof nonce !== 'string' || typeof value !== 'string' || !/^\d+$/.test(value)) {
    return refuse('payment_invalid', 'the payment carries no readable authorization', 402);
  }

  const facilitator = {
    url: network.facilitatorUrl ?? env.FACILITATOR_URL ?? '',
    ...(env.FACILITATOR_API_KEY ? { apiKey: env.FACILITATOR_API_KEY } : {}),
  };
  if (!facilitator.url) return refuse('unconfigured', 'no facilitator configured; paid routes are closed', 503);

  const checked = await verifyPayment(facilitator, payment, reqs);
  if (!checked.ok) return refuse('payment_invalid', checked.reason, 402);
  const settled = await settlePayment(facilitator, payment, reqs);
  if (!settled.ok) return refuse('payment_unsettled', `payment did not settle: ${settled.reason}`, 402);

  /*
    What was signed is what is credited. The quote check accepts overpaying, so
    the authorization's own value can exceed the quote — and it is that value
    that moved.
  */
  const tab = env.TAB.getByName(`${network.id}:${from.toLowerCase()}`);
  const credit = await tab.credit(nonce.toLowerCase(), value);

  return json(
    {
      network: network.id,
      payer: from.toLowerCase(),
      creditedMinor: credit.credited ? value : '0',
      balanceMinor: credit.balanceMinor,
    },
    200,
    { [HEADER.response]: base64(JSON.stringify(settled.body)) },
  );
};

/**
 * Serves a call out of a tab, and charges the tab what the call cost.
 *
 *   verify voucher  →  reserve its ceiling  →  upstream  →  meter  →  settle
 *
 * The reserve happens before the upstream call, for the reason settlement does
 * on the per-call route: nothing is spent on a caller's behalf until their
 * money is committed. The tab already holds it, so committing is one atomic
 * write rather than a trip to a facilitator — which is where a tab call gets
 * faster than a paid one.
 */
const handleTabCompletion = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  network: NetworkConfig,
  model: Model,
  signed: SignedVoucher,
): Promise<Response> => {
  if (!env.TAB) return refuse('tab_unavailable', 'this gate keeps no tabs', 503);
  if (network.kind !== 'gateway') {
    return refuse('tab_unsupported_network', `tabs are kept on Gateway networks; ${network.id} is not one`, 400);
  }

  const voucher = signed.voucher;
  if (!sameIdentifier('evm', voucher.payee, network.payTo)) {
    return refuse('voucher_wrong_gate', 'the voucher pays a different gate', 402);
  }
  if (voucher.expiresAt * 1000 <= Date.now()) {
    return refuse('voucher_expired', 'the voucher has expired', 402);
  }

  const reserve = model.reserveMinor * network.unitsPerUsdMinor;
  if (BigInt(voucher.maxAmount) < reserve) {
    return refuse(
      'voucher_under_reserve',
      `this model reserves ${reserve} per call and the voucher allows ${voucher.maxAmount}`,
      402,
    );
  }

  /*
    The chain id comes from this gate's own configuration, never the request.
    It is inside the signed domain, so taking it from the caller would let a
    voucher signed for one chain be presented as if it were for this one.
  */
  const chainId = Number(network.id.slice('eip155:'.length));
  const signer = await recoverVoucherSigner(signed, chainId);
  if (!signer || !sameIdentifier('evm', signer, voucher.payer)) {
    return refuse('voucher_invalid', 'the voucher is not signed by the wallet it charges', 402);
  }

  const payer = voucher.payer.toLowerCase();
  const nonce = voucher.nonce.toLowerCase();
  const tab = env.TAB.getByName(`${network.id}:${payer}`);

  const reserved = await tab.reserve(nonce, reserve.toString(), voucher.node);
  if (!reserved.ok) {
    if (reserved.reason === 'nonce_used') {
      return refuse('voucher_used', 'this voucher has already been spent', 402);
    }
    /*
      Distinct from every other 402 here, because it asks for something
      different: not a payment for this call, but more money in the tab. The
      client tops up and presents a fresh voucher.
    */
    return json(
      {
        error: {
          code: 'tab_insufficient',
          detail: `the tab holds ${reserved.balanceMinor} and this call reserves ${reserve}`,
        },
        balanceMinor: reserved.balanceMinor,
        reserveMinor: reserve.toString(),
        topup: new URL('/v1/tab/topup', request.url).toString(),
      },
      402,
    );
  }

  const receiptFor = (settled: Settled | null) =>
    settled ? { nonce: signed.voucher.nonce, chargedMinor: settled.chargedMinor, balanceMinor: settled.balanceMinor } : null;

  const upstream = await callUpstream(request, env);
  if (!upstream.ok) {
    /*
      Nothing was delivered, so nothing is charged. This is the refund the
      per-call route cannot make: the money never left the tab, and releasing
      the reservation is a write rather than a transfer.
    */
    const released = receiptFor(await tab.settle(nonce, '0'));
    console.error('upstream failed on a tab call', upstream.reason);
    return json(
      { error: { code: 'upstream_failed', detail: `the upstream call failed and nothing was charged: ${upstream.reason}` } },
      502,
      released ? { [TAB_HEADER.receipt]: encodeReceipt(released) } : {},
    );
  }

  const charge = (usage: Parameters<typeof chargeFor>[1]) =>
    (chargeFor(model, usage) * network.unitsPerUsdMinor).toString();

  if (!upstream.body || !upstream.contentType.includes('text/event-stream')) {
    const text = upstream.body ? await new Response(upstream.body).text() : '';
    const receipt = receiptFor(await tab.settle(nonce, charge(usageFromJson(text))));
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': upstream.contentType,
        ...(receipt ? { [TAB_HEADER.receipt]: encodeReceipt(receipt) } : {}),
      },
    });
  }

  /*
    A stream is metered on a branch of its own.

    The caller's branch passes through untouched and ends with the receipt. The
    meter's branch reads the same bytes into a scanner that keeps only the last
    usage it saw, and settles the tab when the upstream finishes — under
    `waitUntil`, so a caller who hangs up mid-answer is still charged for what
    the upstream produced rather than leaving the reservation open. Metering
    inside the caller's branch would have tied the charge to whether they kept
    reading.
  */
  const [toCaller, toMeter] = upstream.body.tee();

  const settling = (async (): Promise<Settled | null> => {
    const scanner = new UsageScanner();
    const reader = toMeter.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scanner.push(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      console.error('tab stream ended early', (error as Error).message);
    }
    return tab.settle(nonce, charge(scanner.finish()));
  })();
  ctx.waitUntil(settling.catch((error) => console.error('tab settlement failed', error)));

  const receipted = toCaller.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush(controller) {
        try {
          const receipt = receiptFor(await settling);
          if (receipt) controller.enqueue(encoder.encode(receiptComment(receipt)));
        } catch {
          /* the charge still lands under waitUntil; only the caller's copy of the receipt is lost */
        }
      },
    }),
  );

  return new Response(receipted, {
    status: 200,
    headers: {
      'content-type': upstream.contentType,
      /*
        The nonce up front, so a caller whose stream is cut before the receipt
        still knows which voucher to ask about afterwards.
      */
      'X-Tab-Nonce': signed.voucher.nonce,
    },
  });
};

type Upstream =
  | { ok: true; body: ReadableStream<Uint8Array> | null; contentType: string }
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

    if (response.ok) {
      /*
        The body is handed back unread, so it can be piped to the caller as it
        arrives rather than buffered here. That is the whole of streaming
        support: the gate does not need to understand SSE, only to stop
        collecting it. Whether a response streams is then the caller's choice,
        made with `stream: true` in the body we forwarded verbatim.

        It also means retrying is only possible up to this point. Once these
        bytes start moving there is no second attempt — which is why the retry
        decision is made on the status line, before anything is consumed.
      */
      return {
        ok: true,
        body: response.body,
        contentType: response.headers.get('content-type') ?? 'application/json',
      };
    }

    const text = await response.text();
    last = `upstream ${response.status}`;
    if (!RETRYABLE.has(response.status) || attempt === ATTEMPTS) {
      // The body of a failed response is worth quoting: an upstream 400 usually
      // says which field it disliked, and the caller has paid for the answer.
      return { ok: false, reason: text ? `${last}: ${text.slice(0, 200)}` : last };
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
