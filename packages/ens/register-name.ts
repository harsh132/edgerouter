/**
 * Registers the root name every agent name hangs from.
 *
 *   bun packages/ens/register-name.ts edgerouter
 *   bun packages/ens/register-name.ts edgerouter --years 2
 *
 * Run once. It spends testnet gas and mints its own fee token, so the only
 * thing it needs from a human is that the wallet holds Sepolia ETH.
 *
 * The wait in the middle is not padding: a commitment must be at least
 * `MIN_COMMITMENT_AGE` old before it can be revealed, and this deployment
 * counts that from the block the commitment landed in. So the script sleeps
 * rather than retrying — retrying a `register` that is merely early burns gas
 * to learn something the clock already knows.
 */
import { formatEther, formatUnits } from 'viem';
import { ENS, ENS_APP, ENS_EXPLORER, YEAR_SECONDS, commit, ensureFunds, openEnsSigner, planRegistration, register, createEnsClient } from './src/index';

const label = process.argv[2] ?? 'edgerouter';
const yearsAt = process.argv.indexOf('--years');
const years = yearsAt >= 0 ? Number(process.argv[yearsAt + 1] ?? '1') : 1;
if (!Number.isFinite(years) || years <= 0) {
  console.error('\n  --years takes a positive number\n');
  process.exit(1);
}

const signer = openEnsSigner();
const say = (line = '') => console.log(line);

say(`\n  registering  ${label}.eth`);
say(`  owner        ${signer.address}`);

const gas = await signer.public.getBalance({ address: signer.address });
say(`  gas          ${formatEther(gas)} ETH`);
if (gas === 0n) {
  console.error('\n  This address has no Sepolia ETH, so no transaction can be sent.');
  console.error('  Fund it from a Sepolia faucet and run this again.\n');
  process.exit(1);
}

const plan = await planRegistration(signer.public, {
  label,
  owner: signer.address,
  durationSeconds: YEAR_SECONDS * BigInt(years),
});
say(`  price        ${formatUnits(plan.priceMinor, 6)} USDC for ${years} year${years === 1 ? '' : 's'}`);

const funds = await ensureFunds({ public: signer.public, wallet: signer.wallet }, plan);
if (funds.minted) say(`  minted       ${funds.minted}`);
if (funds.approved) say(`  approved     ${funds.approved}`);

const committed = await commit({ public: signer.public, wallet: signer.wallet }, plan);
say(`  committed    ${committed.hash}`);
await signer.public.waitForTransactionReceipt({ hash: committed.hash });

/*
  One second over the minimum. The age is measured against block timestamps, and
  a block whose timestamp lands exactly on the boundary is not older than it.
*/
const waitMs = (committed.minAgeSeconds + 1) * 1000;
say(`  waiting      ${committed.minAgeSeconds + 1}s for the commitment to age`);
await new Promise((resolve) => setTimeout(resolve, waitMs));

const registered = await register({ public: signer.public, wallet: signer.wallet }, plan);
const receipt = await signer.public.waitForTransactionReceipt({ hash: registered.hash });
say(`  registered   ${registered.hash}`);
say(`  status       ${receipt.status}`);

/*
  Resolution, checked immediately — and this is the first moment it can be
  checked at all. Until a name exists on this deployment, a Universal Resolver
  pointed at the wrong contracts and one pointed at the right ones both answer
  "nothing", so the override has been unproven until now.
*/
const ens = createEnsClient();
const resolver = await ens.resolverOf(`${label}.eth`);
say(`\n  resolver     ${resolver ?? 'none — the name registered but resolves to nothing'}`);

say(`\n  manage       ${ENS_APP}`);
say(`  explorer     ${ENS_EXPLORER}`);
say(`  registry     ${ENS.ethRegistry}\n`);
