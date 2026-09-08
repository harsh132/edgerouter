/**
 * Per-chat budgets, with real money, against the real gate.
 *
 * 0.13.0 gave every chat its own allowance. `packages/dsh/check.ts` proves the
 * adapter asks for a signer per session and falls back to the wallet when a
 * chat has none — but it proves that against a fake gate, with a fake signer,
 * over no socket at all.
 *
 * This proves the claim the feature is actually making: two chats, two
 * allowances out of one wallet, both buying real inference, and revoking one
 * stopping that chat and nothing else. Isolation that has never been tested by
 * cutting something off is not isolation, it is a data structure.
 *
 *   bun packages/sdk/per-chat-live-check.ts
 *
 * Spends testnet USDC from the Gateway balance on Arc. Not part of `bun run check`.
 */
import {
  createAuthority,
  authorityHandler,
  connectAuthority,
  evmSigner,
  loadOrCreateEvmWallet,
  payAndFetch,
  AuthorityDenied,
} from './src/index';
import { GatewayClient } from '@circle-fin/x402-batching/client';

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Promise<Response>;
  }): { stop(): void };
};

const GATE = 'https://edgerouter-gate.prakashharsh32.workers.dev';
const ARC = 'eip155:5042002';
const PORT = 8793;

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const { wallet } = loadOrCreateEvmWallet({ network: ARC });
const privateKey = wallet.exportPrivateKey() as `0x${string}`;
const address = wallet.address as `0x${string}`;

const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey });
const before = await gateway.getBalances(address);

console.log('\n  Two chats, two budgets, one wallet\n');
console.log(`  wallet           ${address}`);
console.log(`  gateway balance  ${before.gateway.formattedAvailable}\n`);

if (before.gateway.available === 0n) {
  console.log('  Nothing deposited into the Gateway, so nothing can be paid from it.\n');
  process.exit(0);
}

/*
  Budgets big enough for a couple of calls each — the refusal this check is
  after is a revocation, not an exhaustion, and those are different codes.
*/
const PER_CHAT = 20_000n; // ~10 calls at the 2000-unit going rate
const authority = await createAuthority({
  signer: evmSigner({ privateKey, network: ARC }),
  secret: crypto.randomUUID(),
  fundedMinor: PER_CHAT * 2n,
});

const server = Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: authorityHandler(authority) });

const openChat = async (name: string) => {
  const granted = await authority.mint({
    parent: authority.rootToken,
    child: name,
    amountMinor: PER_CHAT,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  const connection = await connectAuthority({
    url: `http://127.0.0.1:${PORT}`,
    capability: granted.capability,
    resourceUrl: GATE,
  });
  return { name, connection };
};

const chatA = await openChat('chat-a');
const chatB = await openChat('chat-b');
check(true, 'two chats each hold their own allowance', `${PER_CHAT} units apiece`);

const ask = async (chat: typeof chatA, say: string) =>
  payAndFetch(new URL('/v1/chat/completions', GATE).toString(), {
    signer: chat.connection.signer,
    network: ARC,
    maxAmount: 1_000_000n,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: `Reply with exactly: ${say}` }],
      }),
    },
  });

/* --------------------------------------------------- both chats can spend */

for (const chat of [chatA, chatB]) {
  const result = await ask(chat, chat.name);
  check(result.response.status === 200, `${chat.name} bought an answer`, String(result.response.status));
}

const spentA = PER_CHAT - (chatA.connection.remainingMinor() ?? 0n);
const spentB = PER_CHAT - (chatB.connection.remainingMinor() ?? 0n);
check(spentA > 0n && spentB > 0n, 'each drew down its own budget', `${spentA} / ${spentB} units`);

/*
  The separation. Both chats came out of one wallet, so the only thing making
  them distinct is the tree — and if the tree were bookkeeping over a shared
  pot, one chat's spending would show up in the other's balance.
*/
check(
  (authority.balances('chat-a')[0]?.balanceMinor ?? -1n) === (chatA.connection.remainingMinor() ?? -2n),
  'the authority agrees with what chat-a thinks it has left',
);
check(
  (authority.balances('chat-b')[0]?.balanceMinor ?? -1n) === PER_CHAT - spentB,
  'and chat-b was not charged for chat-a’s call',
);

/* ------------------------------------------------------ revoking just one */

authority.revoke({ token: authority.rootToken, node: 'chat-a' });
check(true, 'chat-a revoked');

let denial: AuthorityDenied | null = null;
try {
  await ask(chatA, 'chat-a again');
} catch (error) {
  if (error instanceof AuthorityDenied) denial = error;
  else throw error;
}
check(denial !== null, 'chat-a can no longer spend', denial?.code ?? 'it still paid');

const after = await ask(chatB, 'chat-b still here');
check(after.response.status === 200, 'and chat-b is untouched', String(after.response.status));

server.stop();

const left = await gateway.getBalances(address);
console.log(`\n  gateway before   ${before.gateway.formattedAvailable}`);
console.log(`  gateway after    ${left.gateway.formattedAvailable}`);
check(left.gateway.available < before.gateway.available, 'and the money actually left');

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
