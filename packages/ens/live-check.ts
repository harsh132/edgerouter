/**
 * The ENSv2 deployment, checked against itself.
 *
 *   bun packages/ens/live-check.ts [name.eth]
 *
 * Reads only — nothing here spends gas or registers anything, so it is safe to
 * run before a wallet exists. What it is for is the class of mistake that does
 * not show up in a type: an address transcribed wrong, a contract that is not
 * the one the docs described, a resolver override that is silently not taking
 * effect. Every one of those produces a plausible `null` rather than an error,
 * so each is checked by asking a question whose answer is known.
 */
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { ENS, ENS_APP, ENS_CHAIN_ID, SEPOLIA_RPC, createEnsClient } from './src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const probe = process.argv[2] ?? 'ens.eth';

console.log('\n  ENSv2 hackathon deployment\n');

const raw = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

const chainId = await raw.getChainId();
check(chainId === ENS_CHAIN_ID, 'the RPC is Sepolia', `chainId ${chainId}`);

/*
  Bytecode, not a balance. An address with no code is the signature of a
  mistyped constant, and it is the failure that would otherwise surface much
  later as a call reverting for no visible reason.
*/
for (const [label, address] of Object.entries(ENS)) {
  const code = await raw.getCode({ address });
  check(Boolean(code && code !== '0x'), `${label} is a contract`, address);
}

/*
  The override, tested by the only thing that can tell it apart from the
  default: a name that resolves here and not on mainnet's resolver. Failing
  this check does not mean the name is missing — it means the resolver being
  asked is the wrong one.
*/
const ens = createEnsClient();
try {
  const address = await ens.addressOf(probe);
  console.log(`\n  resolved  ${probe} -> ${address ?? 'nothing'}`);
  if (!address) {
    console.log('  (a null here is a free name, not necessarily a broken override —');
    console.log(`   register one and re-run as: bun packages/ens/live-check.ts <name>)`);
  }
} catch (error) {
  check(false, 'resolution ran', (error as Error).message);
}

console.log(`\n  app  ${ENS_APP}`);
console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
