/**
 * Deploys `Batch7702` and tells you how to use it.
 *
 *   bun packages/ens/deploy-batcher.ts
 *   bun packages/ens/deploy-batcher.ts --check
 *
 * Compiles from source rather than from a committed hex blob, so what goes on
 * chain is what is in `contracts/Batch7702.sol` beside it. The account is not
 * delegated here: the authorization rides along with the first batch that
 * actually needs it, which is one fewer transaction and one fewer way to end up
 * delegated to a contract you never used.
 */
import { formatEther } from 'viem';
import { compileBatcher } from './src/compile';
import { batchingState, delegateOf, openEnsSigner, BATCHER } from './src/index';

const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const say = (line = '') => console.log(line);

const current = await delegateOf(signer.public, signer.address);

say();
say(`  account     ${signer.address}`);
say(`  balance     ${formatEther(await signer.public.getBalance({ address: signer.address }))} ETH`);
say(`  delegate    ${current ?? 'none — a plain EOA'}`);
say(`  ENS_BATCHER ${BATCHER ?? 'unset — batching is off'}`);
if (BATCHER) say(`  batching    ${await batchingState(clients)}`);

if (process.argv.includes('--check')) process.exit(0);

/*
  A delegation to something else is not overwritten. This script did not put it
  there, so it does not get to decide it should go.
*/
if (current && BATCHER && current.toLowerCase() !== BATCHER.toLowerCase()) {
  say(`\n  this account already delegates to ${current}, which is not the configured batcher.`);
  say('  clear it deliberately before pointing it somewhere else.\n');
  process.exit(1);
}

const compiled = compileBatcher();
say(`\n  compiled    ${compiled.solc.split('+')[0]}, ${(compiled.bytecode.length - 2) / 2} bytes`);

const hash = await signer.wallet.deployContract({
  abi: compiled.abi as never,
  bytecode: compiled.bytecode,
  account: signer.wallet.account!,
  chain: signer.wallet.chain!,
});
say(`  deploying   ${hash}`);

const receipt = await signer.public.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  say('\n  the deployment reverted.\n');
  process.exit(1);
}

say(`  batcher     ${receipt.contractAddress}`);
say(`  gas         ${receipt.gasUsed}`);

/*
  Verified by reading it back rather than trusting the receipt. A deployment
  that succeeded and left no code is not a case anyone expects, which is exactly
  why it is worth one call to rule out.
*/
const code = await signer.public.getCode({ address: receipt.contractAddress });
say(`  on chain    ${code && code !== '0x' ? `${(code.length - 2) / 2} bytes of runtime code` : 'nothing — stop here'}`);

say('\n  set this and every mint becomes one transaction:\n');
say(`    ENS_BATCHER=${receipt.contractAddress}`);
say('\n  the account is not delegated yet. The first batch that needs it will');
say('  carry the authorization, so nothing else has to be run.\n');
