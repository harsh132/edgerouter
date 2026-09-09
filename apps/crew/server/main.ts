/**
 * The local runtime, and the only thing that holds a key.
 *
 * The browser gets a UI that can ask this process to act; it never sees the
 * wallet, the capabilities, or the ENS signer. That split is not ceremony — a
 * page can be read by anything running on it, and this key signs payments and
 * registry writes. So the key stays in a process the user started, and the
 * page's whole power is the four routes below.
 *
 *   GET  /api/state            what exists right now
 *   GET  /api/events           the same, as it changes
 *   POST /api/agents           hire one
 *   POST /api/agents/:id/task  give it something to do
 *   POST /api/agents/:id/stop  interrupt it
 *   POST /api/agents/:id/fire  revoke it, on chain
 *
 * Bound to loopback, for the obvious reason.
 */
import { formatAmount } from '../../../packages/sdk/src/index';
import { ROOT_NAME } from '../../../packages/ens/src/index';
import { boot, hire, fire, update, agentById, type Runtime } from './crew';
import { runTask, stop, isRunning } from './run';
import { subscribe } from './events';
import { MODELS } from './model';
import { FILE_PATH } from './store';

/*
  Declared rather than imported from `@types/bun`.

  The workspace already types a Cloudflare Worker, and Bun's global types
  redefine `fetch`, `Request` and `Response` in ways that collide with
  `@cloudflare/workers-types`. Two runtimes in one typecheck is a fight nobody
  wins, so this file borrows the three members it actually uses — the same
  approach the SDK's live checks take.
*/
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    idleTimeout?: number;
    fetch: (request: Request) => Promise<Response>;
  }): unknown;
  file(path: string): { exists(): Promise<boolean> } & BodyInit;
};

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const PORT = Number(process.env.CREW_PORT ?? 8800);
const GATE = process.env.CREW_GATE ?? 'https://edgerouter-gate.prakashharsh32.workers.dev';
const NETWORK = process.env.CREW_NETWORK ?? 'hedera:testnet';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stateOf = (runtime: Runtime) => ({
  gate: runtime.gate,
  network: runtime.wallet.network,
  account: runtime.wallet.account,
  spendableMinor: runtime.wallet.spendableMinor.toString(),
  spendable: formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor),
  ...(runtime.wallet.heldMinor === undefined
    ? {}
    : { held: formatAmount(runtime.wallet.network, runtime.wallet.heldMinor) }),
  naming: runtime.naming,
  root: ROOT_NAME,
  models: MODELS,
  file: FILE_PATH,
  agents: runtime.crew.agents.map((agent) => ({
    ...agent,
    running: isRunning(agent.id),
    budget: formatAmount(agent.network, BigInt(agent.budgetMinor)),
    spent: formatAmount(agent.network, BigInt(agent.spentMinor)),
  })),
});

console.log('\n  edgerouter crew\n');
console.log(`  gate     ${GATE}`);
console.log(`  network  ${NETWORK}`);

let runtime: Runtime;
try {
  runtime = await boot({ gate: GATE, network: NETWORK });
} catch (error) {
  console.error(`\n  cannot start: ${(error as Error).message}\n`);
  process.exit(1);
}

console.log(`  wallet   ${runtime.wallet.account}`);
console.log(`  can spend ${formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor)}`);
console.log(`  names    ${runtime.naming ? `under ${ROOT_NAME}` : 'off — the root name owns no registry here'}`);
console.log(`\n  open http://127.0.0.1:${PORT}\n`);

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/state') return json(stateOf(runtime));

    /*
      One stream, opened once, carrying every change. The roster is pushed on
      connect so a browser that arrives mid-task sees the current state rather
      than an empty page waiting for the next event.
    */
    if (path === '/api/events') {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ type: 'state', state: stateOf(runtime) });
          const unsubscribe = subscribe((event) => {
            send(event.type === 'crew' ? { type: 'state', state: stateOf(runtime) } : event);
          });
          request.signal.addEventListener('abort', () => {
            unsubscribe();
            try {
              controller.close();
            } catch {
              // Already closed by the client going away.
            }
          });
        },
      });
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }

    if (request.method === 'POST' && path === '/api/agents') {
      const body = (await request.json()) as {
        label: string;
        brief: string;
        budgetMinor: string;
        model: string;
        avatar?: string;
        header?: string;
      };
      try {
        const agent = await hire(runtime, {
          label: body.label,
          brief: body.brief,
          budgetMinor: BigInt(body.budgetMinor),
          model: body.model,
          ...(body.avatar ? { avatar: body.avatar } : {}),
          ...(body.header ? { header: body.header } : {}),
        });
        return json({ agent: agent.id });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    const match = /^\/api\/agents\/([^/]+)\/(task|stop|fire|edit)$/.exec(path);
    if (request.method === 'POST' && match) {
      const [, id, action] = match as unknown as [string, string, string];
      try {
        const agent = agentById(runtime, id);

        if (action === 'stop') return json({ stopped: stop(id) });
        if (action === 'edit') {
          const changes = (await request.json()) as {
            brief?: string;
            model?: string;
            budgetMinor?: string;
            avatar?: string;
            header?: string;
          };
          await update(runtime, id, {
            ...(changes.brief === undefined ? {} : { brief: changes.brief }),
            ...(changes.model === undefined ? {} : { model: changes.model }),
            ...(changes.budgetMinor === undefined ? {} : { budgetMinor: BigInt(changes.budgetMinor) }),
            ...(changes.avatar === undefined ? {} : { avatar: changes.avatar }),
            ...(changes.header === undefined ? {} : { header: changes.header }),
          });
          return json({ updated: true });
        }
        if (action === 'fire') {
          await fire(runtime, id);
          return json({ fired: true });
        }

        const { prompt } = (await request.json()) as { prompt: string };
        if (!prompt?.trim()) return json({ error: 'a task needs a prompt' }, 400);
        /*
          Not awaited. A task runs for as long as its budget lasts, and the
          browser wants the roster back immediately — everything it needs to
          watch arrives on the event stream.
        */
        void runTask(runtime, agent, prompt).catch(() => {
          // runTask records its own failures on the task; nothing to add here.
        });
        return json({ started: true });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    /*
      Everything else is the UI. Built assets when they exist, so a demo is one
      command; in development Vite serves the page and proxies these routes.
    */
    const file = Bun.file(`${HERE}../dist${path === '/' ? '/index.html' : path}`);
    if (await file.exists()) return new Response(file);
    const index = Bun.file(`${HERE}../dist/index.html`);
    if (await index.exists()) return new Response(index);

    return new Response('the UI is not built — run `bun run dev` in apps/crew', { status: 404 });
  },
});
