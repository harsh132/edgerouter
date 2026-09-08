/**
 * Shows this wallet's session name, minting it the first time.
 *
 *   bun packages/ens/session-name.ts
 *   bun packages/ens/session-name.ts --seed demo
 *
 * Safe to run repeatedly: the name is looked up before anything is minted, so
 * the second run is a read.
 */
import { formatEther } from 'viem';
import { ENS_APP, ensureSessionName, openEnsSigner, sessionLabelFor, createEnsClient, RECORD } from './src/index';

const at = process.argv.indexOf('--seed');
const seed = at >= 0 ? (process.argv[at + 1] ?? '') : '';

const signer = openEnsSigner();
const say = (line = '') => console.log(line);

say(`\n  wallet     ${signer.address}`);
say(`  label      ${sessionLabelFor(signer.address, seed)}`);

const gas = await signer.public.getBalance({ address: signer.address });
say(`  gas        ${formatEther(gas)} ETH`);

const session = await ensureSessionName(
  { public: signer.public, wallet: signer.wallet },
  { owner: signer.address, seed, gate: 'https://edgerouter-gate.prakashharsh32.workers.dev' },
);

say(`\n  name       ${session.name}`);
say(`  ${session.minted ? 'minted' : 'found'}     ${session.registerHash ?? 'already existed'}`);
say(`  registry   ${session.registry}`);

const ens = createEnsClient();
say(`\n  resolves   ${(await ens.addressOf(session.name)) ?? 'nothing'}`);
say(`  parent     ${await ens.textOf(session.name, RECORD.parent)}`);
say(`\n  app        ${ENS_APP}\n`);
