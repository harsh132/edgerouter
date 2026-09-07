/**
 * The authority as an HTTP surface.
 *
 * A plain `(Request) => Response` handler with no framework, so the same code
 * runs under `Bun.serve`, Node's `fetch` adapters, and a Worker. The authority
 * itself knows nothing about HTTP; this only translates.
 *
 * Bind it to loopback. The capability is a bearer token — that is the whole
 * point of a macaroon, and it means anything that can reach this port and
 * holds a token can spend that token's budget. On one machine, shared between
 * an agent and its sub-agents, that is the intended shape. Exposed publicly it
 * is a wallet with an HTTP interface.
 *
 * Note what is deliberately *not* here: no route mints from the root. Root
 * minting needs the root capability, which the process holds in memory, and
 * exposing it over HTTP would make the front door of the wallet a request. A
 * parent mints for its children through `/mint` with its own token; the root
 * mints in-process, through the `Authority` object.
 */
import { AuthorityRefused, parseMinor, type Authority } from './authority';
import type {
  BalancesResponse,
  MintRequest,
  MintResponse,
  RevokeRequest,
  RevokeResponse,
  SignRequest,
  SignResponse,
} from './wire';
import type { PaymentRequirements } from '../pay/types';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fail = (error: unknown): Response => {
  if (error instanceof AuthorityRefused) {
    /*
      Status follows the code rather than a blanket 400, because a caller
      automating against this has to distinguish "stop" from "ask for less".
      402 is honest for an exhausted budget: it is precisely payment required.
    */
    const status =
      error.code === 'bad_capability'
        ? 401
        : error.code === 'budget_exhausted'
          ? 402
          : error.code === 'bad_request'
            ? 400
            : error.code === 'signing_failed'
              ? 502
              : 403;
    return json({ error: { code: error.code, detail: error.message } }, status);
  }
  // Nothing else is described to the caller. An unexpected throw here happened
  // inside a process holding a private key, and its message is not for them.
  console.error('authority: unexpected failure', error);
  return json({ error: { code: 'signing_failed', detail: 'the authority failed' } }, 500);
};

const bearer = (request: Request): string => {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new AuthorityRefused('bad_capability', 'expected an Authorization: Bearer capability');
  }
  return header.slice(7).trim();
};

const body = async (request: Request): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AuthorityRefused('bad_request', 'body must be JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AuthorityRefused('bad_request', 'body must be a JSON object');
  }
  return value as Record<string, unknown>;
};

/**
 * Narrows the requirements a caller wants signed.
 *
 * Every field is checked rather than cast. This object decides how much money
 * moves and to whom, and it arrived from a sub-agent — which is the one party
 * in the system with a reason to lie about it.
 */
const readRequirements = (value: unknown): PaymentRequirements => {
  if (!value || typeof value !== 'object') {
    throw new AuthorityRefused('bad_request', 'requirements must be an object');
  }
  const r = value as Record<string, unknown>;
  const text = (field: string): string => {
    const entry = r[field];
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new AuthorityRefused('bad_request', `requirements.${field} must be a non-empty string`);
    }
    return entry;
  };

  parseMinor(r.amount, 'requirements.amount');

  return {
    scheme: text('scheme'),
    network: text('network'),
    amount: text('amount'),
    asset: text('asset'),
    payTo: text('payTo'),
    maxTimeoutSeconds:
      typeof r.maxTimeoutSeconds === 'number' && Number.isFinite(r.maxTimeoutSeconds)
        ? r.maxTimeoutSeconds
        : 60,
    ...(r.extra && typeof r.extra === 'object'
      ? { extra: r.extra as Record<string, unknown> }
      : {}),
  };
};

export const authorityHandler = (authority: Authority) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') {
        // No capability, and no balances: enough to see the process is alive
        // and paying from the account you expect, and nothing more.
        return json({ ok: true, account: authority.account, network: authority.network });
      }

      const { token, policy } = await authority.open(bearer(request));

      if (url.pathname === '/whoami') {
        return json({
          node: token.node,
          account: authority.account,
          network: authority.network,
          ceilingMinor: policy.ceilingMinor?.toString() ?? null,
          expiresAt: policy.expiresAt,
          allowHosts: policy.allowHosts,
          maxDepth: policy.maxDepth,
        });
      }

      if (url.pathname === '/sign' && request.method === 'POST') {
        const raw = (await body(request)) as unknown as SignRequest;
        const authorized = await authority.authorize({
          token,
          policy,
          x402Version: typeof raw.x402Version === 'number' ? raw.x402Version : 2,
          requirements: readRequirements(raw.requirements),
          ...(typeof raw.resourceUrl === 'string' ? { resourceUrl: raw.resourceUrl } : {}),
        });
        const reply: SignResponse = {
          payload: authorized.payload,
          remainingMinor: authorized.remainingMinor.toString(),
        };
        return json(reply);
      }

      if (url.pathname === '/mint' && request.method === 'POST') {
        const raw = (await body(request)) as unknown as MintRequest;
        if (typeof raw.child !== 'string') {
          throw new AuthorityRefused('bad_request', 'child must be a string');
        }
        if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) {
          throw new AuthorityRefused('bad_request', 'expiresAt must be unix milliseconds');
        }
        const granted = await authority.mint({
          parent: token,
          child: raw.child,
          amountMinor: parseMinor(raw.amountMinor, 'amountMinor'),
          expiresAt: raw.expiresAt,
          ...(raw.ceilingMinor === undefined
            ? {}
            : { ceilingMinor: parseMinor(raw.ceilingMinor, 'ceilingMinor') }),
          ...(Array.isArray(raw.allowHosts) ? { allowHosts: raw.allowHosts } : {}),
          ...(typeof raw.maxDepth === 'number' ? { maxDepth: raw.maxDepth } : {}),
        });
        const reply: MintResponse = {
          capability: granted.capability,
          child: granted.child,
          amountMinor: granted.amountMinor.toString(),
          expiresAt: granted.expiresAt,
        };
        return json(reply);
      }

      if (url.pathname === '/revoke' && request.method === 'POST') {
        const raw = (await body(request)) as unknown as RevokeRequest;
        if (typeof raw.node !== 'string') {
          throw new AuthorityRefused('bad_request', 'node must be a string');
        }
        const result = authority.revoke({ token, node: raw.node });
        const reply: RevokeResponse = {
          node: raw.node,
          recoveredMinor: result.recoveredMinor.toString(),
        };
        return json(reply);
      }

      if (url.pathname === '/balances') {
        const reply: BalancesResponse = {
          account: authority.account,
          network: authority.network,
          nodes: authority.balances(token.node).map((entry) => ({
            id: entry.id,
            parent: entry.parent,
            depth: entry.depth,
            balanceMinor: entry.balanceMinor.toString(),
          })),
        };
        return json(reply);
      }

      return json({ error: { code: 'bad_request', detail: 'no such route' } }, 404);
    } catch (error) {
      return fail(error);
    }
  };
};
