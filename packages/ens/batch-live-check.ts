/**
 * Proves the batch does what the comments say.
 *
 *   bun packages/ens/batch-live-check.ts
 *
 * Mints a throwaway name against Sepolia and checks the three claims that
 * matter, none of which can be established without a chain:
 *
 *   1. A whole mint is **one** transaction. Not "fewer" — one hash, one
 *      receipt, for a register, every record, and the profile including a data
 *      URI avatar of the size a real sigil is.
 *   2. The account ends up delegated to our batcher and nothing else.
 *   3. `execute` refuses everyone but the account itself. This is the claim the
 *      whole design rests on, and it is the one that would be catastrophic and
 *      silent if wrong: an open `execute` on a delegated EOA is an
 *      unauthenticated "spend as me" endpoint.
 *
 * The name is revoked at the end, so running this twice costs test ETH and
 * leaves nothing behind.
 */
import { encodeFunctionData, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  batcherAbi,
  batchingState,
  BATCHER,
  createEnsClient,
  delegateOf,
  ensureAgentName,
  openEnsSigner,
  parentOf,
  PROFILE,
  RECORD,
  registryOf,
  revokeAgentName,
  ROOT_NAME,
} from './src/index';

let failures = 0;
const check = (claim: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const label = `batch-check-${Math.random().toString(36).slice(2, 8)}`;

console.log('\n  batching a mint into one transaction\n');
console.log(`  account   ${signer.address}`);
console.log(`  balance   ${formatEther(await signer.public.getBalance({ address: signer.address }))} ETH`);
console.log(`  batcher   ${BATCHER ?? 'unset'}`);
console.log(`  state     ${await batchingState(clients)}`);
console.log(`  minting   ${label}.${ROOT_NAME}\n`);

const parentRegistry = await registryOf(signer.public, ROOT_NAME);
if (!parentRegistry) {
  console.error(`  ${ROOT_NAME} owns no registry on this chain; nothing to mint into.\n`);
  process.exit(1);
}

const nonceBefore = await signer.public.getTransactionCount({ address: signer.address });
const started = Date.now();
const minted = await ensureAgentName(clients, {
  label,
  owner: signer.address,
  grantedMinor: 1_000_000n,
  asset: 'hedera:testnet/native',
  /*
    A profile, because the point is that it rides along. The avatar is a data
    URI of about the size a real sigil is — the largest single thing a mint
    writes, and the one worth proving fits in the same transaction as the rest.
  */
  profile: {
    display: 'Batch Check',
    description: 'Proves a mint and its profile are one transaction.',
    avatar: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#123"/>${'<circle cx="64" cy="64" r="40" fill="#9cf"/>'.repeat(20)}</svg>`)}`,
  },
});
const took = Date.now() - started;

/*
  The nonce is the only honest count. It moves once per transaction whatever
  this code believes it did, so a silent fallback to seven sequential writes
  cannot pass as a batch — which is precisely the failure this check exists to
  catch, having already happened once.
*/
const nonceAfter = await signer.public.getTransactionCount({ address: signer.address });
const spent = nonceAfter - nonceBefore;
console.log();
check('the mint produced a transaction', Boolean(minted.registerHash), minted.registerHash ?? 'none');
check('it cost exactly one transaction', spent === 1, `the nonce moved by ${spent}`);
check('and one block, not seven', took < 60_000, `${(took / 1000).toFixed(1)}s`);

const delegate = await delegateOf(signer.public, signer.address);
check(
  'the account now delegates to our batcher',
  delegate?.toLowerCase() === BATCHER?.toLowerCase(),
  delegate ?? 'not delegated',
);

/*
  What actually landed. A batch that reverted internally would still produce a
  receipt, so the records are read back through the resolver rather than
  inferred from the transaction succeeding.
*/
const ens = createEnsClient();
check('the name resolves to the account', (await ens.addressOf(minted.name))?.toLowerCase() === signer.address.toLowerCase());
check('its grant was written in the same transaction', (await ens.textOf(minted.name, RECORD.granted)) === '1000000');
check('its expiry was written too', Boolean(await ens.textOf(minted.name, RECORD.expires)));
check('its parent is the hierarchy, not a record', parentOf(minted.name) === ROOT_NAME, parentOf(minted.name) ?? 'none');
check('the profile went in the same transaction', minted.profileWritten);
check('its display name is readable by any ENS client', (await ens.textOf(minted.name, PROFILE.display)) === 'Batch Check');
check('its avatar survived the batch', ((await ens.textOf(minted.name, PROFILE.avatar)) ?? '').startsWith('data:image/svg+xml,'));

/*
  The security claim, checked from an account that is not ours. A random key
  with no funds is enough: this is a simulation, and what is being established
  is that the call reverts rather than that it is unaffordable.
*/
const stranger = privateKeyToAccount(`0x${'a1'.repeat(32)}`);
const refused = await signer.public
  .call({
    account: stranger.address,
    to: signer.address,
    data: encodeFunctionData({
      abi: batcherAbi,
      functionName: 'execute',
      args: [[{ to: stranger.address, value: 0n, data: '0x' as `0x${string}` }]],
    }),
  })
  .then(() => null)
  .catch((error: Error) => error.message);
/*
  Only meaningful once the account actually runs the batcher. Calling `execute`
  on an EOA with no code succeeds trivially and returns nothing, so asserting it
  reverts would be a test that passes hardest when the feature is off.
*/
check(
  'a stranger calling execute on the delegated account is refused',
  delegate !== null && Boolean(refused && /NotSelf|revert/i.test(refused)),
  delegate === null
    ? 'SKIPPED — not delegated, so there is nothing to refuse'
    : refused
      ? (refused.split('\n')[0] ?? '')
      : 'IT SUCCEEDED — the account is open to anyone',
);

console.log(`\n  nonce is now ${nonceAfter}. Clearing up.\n`);
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
