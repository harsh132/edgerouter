/**
 * Permissions on chain, checked against a chain.
 *
 *   bun packages/ens/permissions-live-check.ts
 *
 * The claim being tested is the one that justifies the record existing at all:
 * that striking a permission from a name takes it away from what the agent can
 * hold, without touching the runtime. Everything else about permissions is
 * already covered without a network — this is the part that needs Sepolia.
 *
 * Also checks the distinction the whole shape rests on: a name with no record
 * is unconstrained, a name with an empty record is constrained to nothing, and
 * those are not the same answer.
 *
 * Mints a throwaway name and revokes it at the end.
 */
import { formatEther } from 'viem';
import {
  createEnsClient,
  ensureAgentName,
  openEnsSigner,
  permissionsOf,
  registryOf,
  revokeAgentName,
  setText,
  NONE,
  RECORD,
  ROOT_NAME,
} from './src/index';

let failures = 0;
const check = (claim: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const ens = createEnsClient();
const label = `perm-check-${Math.random().toString(36).slice(2, 8)}`;

console.log('\n  publishing what an agent may do\n');
console.log(`  account   ${signer.address}`);
console.log(`  balance   ${formatEther(await signer.public.getBalance({ address: signer.address }))} ETH`);
console.log(`  minting   ${label}.${ROOT_NAME}\n`);

const parentRegistry = await registryOf(signer.public, ROOT_NAME);
if (!parentRegistry) {
  console.error(`  ${ROOT_NAME} owns no registry here.\n`);
  process.exit(1);
}

/* An agent that may read and write its own files, and nothing else. */
const minted = await ensureAgentName(clients, {
  label,
  owner: signer.address,
  grantedMinor: 1_000_000n,
  permissions: ['files:read', 'files:write'],
});

const published = await permissionsOf(ens, minted.name);
check('the permission set reaches the chain', published !== null, published?.join(' ') ?? 'nothing');
check(
  'and says what was granted',
  published !== null && published.includes('files:read') && published.includes('files:write'),
);
check(
  'and nothing that was not',
  published !== null && !published.includes('delegate'),
);

/*
  Nothing on chain names a counterparty or a path. This is asserted rather than
  left to review, because it is the property that took an argument to arrive at
  and the easiest one to lose by adding a convenient permission later.
*/
check(
  'no published permission names a third party or a path',
  (published ?? []).every((permission) => permission.split(':').length <= 2),
  (published ?? []).join(' '),
);

/*
  The revocation. `files:write` is struck from the name — the same write anyone
  holding the name could make from a block explorer — and what an agent may
  hold is the intersection of that with whatever it asks for.
*/
console.log('\n  striking files:write on chain …\n');
await setText(clients, {
  resolver: minted.resolver,
  name: minted.name,
  key: RECORD.permissions,
  value: 'files:read',
});

const afterRevoke = await permissionsOf(ens, minted.name);
check(
  'the struck permission is gone from the name',
  afterRevoke !== null && afterRevoke.includes('files:read') && !afterRevoke.includes('files:write'),
  afterRevoke?.join(' ') ?? 'nothing',
);

const asked = ['files:read', 'files:write', 'delegate'];
const effective = asked.filter((permission) => (afterRevoke ?? asked).includes(permission));
check(
  'an agent asking for more than the name allows gets the intersection',
  effective.length === 1 && effective[0] === 'files:read',
  effective.join(' ') || 'nothing',
);

/*
  Empty is not absent. A record saying explicitly nothing must strike
  everything, where a missing record constrains nothing — collapsing the two
  would turn "may do nothing" into "unconstrained".
*/
await setText(clients, {
  resolver: minted.resolver,
  name: minted.name,
  key: RECORD.permissions,
  value: NONE,
});
const emptied = await permissionsOf(ens, minted.name);
check(
  'a name granting nothing reads as empty, not as absent',
  emptied !== null && emptied.length === 0,
  emptied === null ? 'read as absent — everything would be permitted' : `[${emptied.join(' ')}]`,
);

/*
  And the reason `none` exists rather than an empty string: writing '' is
  indistinguishable from never writing, so it publishes the opposite of what
  was meant. Asserted so that a later "simplification" back to '' fails here
  rather than quietly unconstraining every agent that had been struck.
*/
await setText(clients, { resolver: minted.resolver, name: minted.name, key: RECORD.permissions, value: '' });
check(
  'an empty string cannot express it — which is why the word exists',
  (await permissionsOf(ens, minted.name)) === null,
);

const neverSet = await permissionsOf(ens, ROOT_NAME);
check(
  'a name that never published one reads as unconstrained',
  neverSet === null,
  neverSet === null ? 'null' : neverSet.join(' '),
);

console.log('\n  cleaning up.\n');
try {
  await revokeAgentName(clients, {
    parentRegistry,
    label,
    name: minted.name,
    ...(minted.resolver ? { resolver: minted.resolver } : {}),
  });
  console.log(`  revoked   ${minted.name}`);
} catch (error) {
  console.log(`  ${minted.name} could not be cleaned up: ${(error as Error).message.split('\n')[0]}`);
}

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
