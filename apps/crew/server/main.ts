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
import { ARC_TESTNET, formatAmount } from '../../../packages/sdk/src/index';
import { ROOT_NAME } from '../../../packages/ens/src/index';
import {
  addProject,
  agentById,
  boot,
  fire,
  hire,
  refreshFunding,
  removeProject,
  update,
  type Runtime,
} from './crew';
import { runTask, stop, isRunning } from './run';
import { subscribe } from './events';
import { MODELS } from './model';
import { DEFAULT_PERMISSIONS, PERMISSIONS } from './permissions';
import { FILE_PATH } from './store';
import { pending, settle } from './requests';
import { fundingRouteFor, privyAppId } from './funding';

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
/*
  Arc by default, which decides more than which chain settles.

  The unit follows the network everywhere — `formatAmount` renders hbar for
  `hedera:*` and USDC otherwise — so every budget, receipt and ledger row in the
  app is denominated by this line. Arc also pays from a Circle Gateway balance
  rather than a token balance, which is why an address here can hold USDC and
  still be unable to buy anything until it is deposited.
*/
const NETWORK = process.env.CREW_NETWORK ?? ARC_TESTNET;

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
  /*
    What the user has to do before anything can be bought, if anything. The
    page needs the distinction: money missing and money undeposited are one
    transaction apart and share no instructions.
  */
  funded: runtime.wallet.shortfall === undefined,
  ...(runtime.wallet.shortfall ? { shortfall: runtime.wallet.shortfall } : {}),
  /*
    How a person funds this from their own wallet, when the chain has a way.
    Null is a real answer — see `fundingRouteFor`.
  */
  funding: fundingRouteFor(runtime.wallet.network, runtime.wallet.account),
  privyAppId: privyAppId(),
  naming: runtime.naming,
  root: ROOT_NAME,
  models: MODELS,
  /*
    Sent rather than hard-coded in the page, so the checkboxes are the
    permissions this runtime actually enforces. A UI offering one the server has
    never heard of would grant nothing and say it had.
  */
  permissions: Object.entries(PERMISSIONS).map(([name, about]) => ({
    name,
    ...about,
    default: (DEFAULT_PERMISSIONS as string[]).includes(name),
  })),
  file: FILE_PATH,
  /*
    Live, and never from disk. A pending request belongs to a paused tool call
    inside a running task; there is nothing to restore after a restart, because
    the thing that was waiting is gone.
  */
  requests: pending(),
  /*
    Real paths, and only to the page on loopback. They never reach a capability,
    a log, or the chain — an agent's token carries the opaque id, and the chain
    carries only that it may reach some directory at all.
  */
  projects: runtime.crew.projects ?? [],
  agents: runtime.crew.agents.map((agent) => ({
    ...agent,
    running: isRunning(agent.id),
    /*
      Hired on a different chain than the one this runtime opened. Shown rather
      than hidden — the name was minted, the money was spent, and deleting the
      record would be tidier and less true — but it cannot be given work, since
      nothing here can pay for it.
    */
    offNetwork: agent.network !== runtime.wallet.network,
    grants: agent.grants ?? [],
    /*
      Always populated, even for an agent stored before permissions existed.
      The page would otherwise have to know what the default is to render it,
      and a second definition of the default is how the two come to disagree.
    */
    permissions: agent.permissions ?? DEFAULT_PERMISSIONS,
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
console.log(
  runtime.wallet.shortfall === undefined
    ? `  can spend ${formatAmount(runtime.wallet.network, runtime.wallet.spendableMinor)}`
    : runtime.wallet.shortfall === 'undeposited'
      ? `  holds ${formatAmount(runtime.wallet.network, runtime.wallet.heldMinor ?? 0n)}, none of it deposited yet`
      : '  not funded yet — the app will say what to do',
);
console.log(`  names    ${runtime.naming ? `under ${ROOT_NAME}` : 'off — the root name owns no registry here'}`);
console.log(`\n  open http://127.0.0.1:${PORT}\n`);

/** Whether anything would be cut off by rebuilding the delegation tree. */
const busy = (): boolean => runtime.crew.agents.some((agent) => isRunning(agent.id));

/*
  Polled, because a deposit happens in someone else's wallet and nothing tells
  us about it. Slow on purpose: it is a network call per tick, the answer
  changes rarely, and the case where somebody is actually waiting has its own
  endpoint that does not wait for the timer.
*/
setInterval(() => {
  void refreshFunding(runtime, busy).catch(() => undefined);
}, 20_000);

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
            send(
              event.type === 'crew' || event.type === 'requests'
                ? { type: 'state', state: stateOf(runtime) }
                : event,
            );
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
        title?: string;
        brief: string;
        budgetMinor: string;
        model: string;
        avatar?: string;
        header?: string;
        permissions?: string[];
        grants?: { projectId: string; mode: 'read' | 'write' }[];
      };
      try {
        const agent = await hire(runtime, {
          label: body.label,
          brief: body.brief,
          ...(body.title ? { title: body.title } : {}),
          ...(body.permissions ? { permissions: body.permissions } : {}),
          ...(body.grants ? { grants: body.grants } : {}),
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

    /*
      Answering an agent's request for more budget. Approval carries an amount
      rather than a yes, because a person who reads "needs 2 ℏ to finish" and
      thinks "a tenth of that" should be able to say so — and because a granted
      amount somebody typed is a limit they set rather than one they waved
      through.
    */
    /*
      Granting a directory. Separate from granting it to an agent, because
      revoking the first has to take every hold on it with it, and that is only
      simple while the path lives in one place.
    */
    /*
      Look at the chain now rather than at the next poll. Somebody who has just
      confirmed a deposit in their wallet is watching this page waiting for it
      to notice, and twenty seconds of nothing reads as a failure.
    */
    if (request.method === 'POST' && path === '/api/funding/refresh') {
      const changed = await refreshFunding(runtime, busy);
      return json({ changed, funded: runtime.wallet.shortfall === undefined });
    }

    if (request.method === 'POST' && path === '/api/projects') {
      const body = (await request.json()) as { name?: string; path?: string; mode?: 'read' | 'write' };
      if (!body.path?.trim()) return json({ error: 'which directory?' }, 400);
      try {
        const project = addProject(runtime, {
          name: body.name ?? '',
          path: body.path,
          mode: body.mode === 'write' ? 'write' : 'read',
        });
        return json({ project });
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }
    }

    const removing = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (request.method === 'DELETE' && removing) {
      await removeProject(runtime, removing[1]!);
      return json({ removed: true });
    }

    const answering = /^\/api\/requests\/([^/]+)\/(approve|decline)$/.exec(path);
    if (request.method === 'POST' && answering) {
      const [, id, verdict] = answering as unknown as [string, string, string];

      if (verdict === 'decline') {
        return json({ answered: settle(id, { approved: false, why: 'the request was declined' }) });
      }

      const body = (await request.json().catch(() => ({}))) as { grantedMinor?: string };
      let grantedMinor: bigint;
      try {
        grantedMinor = BigInt(body.grantedMinor ?? '0');
      } catch {
        return json({ error: 'that is not an amount' }, 400);
      }
      if (grantedMinor <= 0n) return json({ error: 'grant more than nothing, or decline' }, 400);

      return json({ answered: settle(id, { approved: true, grantedMinor }) });
    }

    const match = /^\/api\/agents\/([^/]+)\/(task|stop|fire|edit)$/.exec(path);
    if (request.method === 'POST' && match) {
      const [, id, action] = match as unknown as [string, string, string];
      try {
        const agent = agentById(runtime, id);

        if (action === 'stop') return json({ stopped: stop(id) });
        if (action === 'edit') {
          const changes = (await request.json()) as {
            title?: string;
            brief?: string;
            model?: string;
            budgetMinor?: string;
            avatar?: string;
            header?: string;
            permissions?: string[];
            grants?: { projectId: string; mode: 'read' | 'write' }[];
          };
          await update(runtime, id, {
            ...(changes.title === undefined ? {} : { title: changes.title }),
            ...(changes.brief === undefined ? {} : { brief: changes.brief }),
            ...(changes.model === undefined ? {} : { model: changes.model }),
            ...(changes.budgetMinor === undefined ? {} : { budgetMinor: BigInt(changes.budgetMinor) }),
            ...(changes.avatar === undefined ? {} : { avatar: changes.avatar }),
            ...(changes.header === undefined ? {} : { header: changes.header }),
            ...(changes.permissions === undefined ? {} : { permissions: changes.permissions }),
            ...(changes.grants === undefined ? {} : { grants: changes.grants }),
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
