/**
 * The authority's HTTP surface, on Node.
 *
 * `authorityHandler` is a plain `(Request) => Response`, which runs unchanged
 * under Bun and in a Worker. Node's `http` module predates both and speaks
 * streams and callbacks, so this translates — and translating is all it does.
 *
 * It exists because the authority now runs *inside DSH*, and DSH is Electron:
 * there is no `Bun.serve` there, and asking a user to start a second process
 * with two environment variables was the thing that made delegation invisible.
 *
 * Loopback only, and not configurable. A capability is a bearer token — the
 * defining property of a macaroon and the reason delegation needs no round trip
 * to a server — so anything that can reach this port and holds a token can spend
 * that token's budget. Between an agent and its sub-agents on one machine that
 * is exactly right. On `0.0.0.0` it is a wallet with an HTTP interface, so
 * binding it there is not offered.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type ServedAuthority = {
  port: number;
  url: string;
  close(): Promise<void>;
};

/**
 * Collects the body, because a `Request` wants it whole.
 *
 * Decoded as text, not bytes. This repo compiles against both Node's types and
 * the Workers types, and the two disagree about `Buffer` and about what may be
 * a `BodyInit`; text is the spelling both accept. Nothing is lost, because
 * every route the authority serves takes JSON — a binary body would have no
 * route to reach.
 */
const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    request.setEncoding('utf8');
    let body = '';
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const toRequest = (incoming: IncomingMessage, body: string): Request => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    else if (value !== undefined) headers.set(key, value);
  }

  const method = incoming.method ?? 'GET';
  return new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
    method,
    headers,
    /*
      Node rejects a body on these, and so does the Request constructor.

      Decoded to a string rather than passed as bytes: this repo also compiles
      against Workers types, whose `BodyInit` has no typed-array member, and
      every route the authority serves takes JSON. A binary body would be
      mangled here — there is no route that accepts one, and inventing bytes
      support for a surface that has none would be pretending.
    */
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
};

const send = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  const headers: Record<string, string> = {};
  /*
    Narrowed through a cast for the same reason as the body: the two type sets
    describe `Headers` differently, and this is the one operation both runtimes
    actually provide.
  */
  (response.headers as unknown as { forEach(fn: (value: string, key: string) => void): void }).forEach(
    (value, key) => {
      headers[key] = value;
    },
  );
  outgoing.writeHead(response.status, headers);
  outgoing.end(await response.text());
};

/**
 * Serves the handler on loopback.
 *
 * Port zero means "any free port", which is the sane default inside a desktop
 * app: a fixed port is a collision waiting to happen with the user's own
 * software, and nothing here needs a well-known number — the URL is handed to
 * sub-agents, not typed by a person.
 */
export const serveAuthority = (
  handler: (request: Request) => Promise<Response>,
  options: { port?: number } = {},
): Promise<ServedAuthority> =>
  new Promise((resolve, reject) => {
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        try {
          const body = await readBody(incoming);
          await send(await handler(toRequest(incoming, body)), outgoing);
        } catch (error) {
          /*
            Nothing about the failure is described. This process holds a private
            key, and an unexpected throw inside it is not the caller's business.
          */
          outgoing.writeHead(500, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: { code: 'signing_failed', detail: 'failed' } }));
          void error;
        }
      })();
    });

    server.on('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
