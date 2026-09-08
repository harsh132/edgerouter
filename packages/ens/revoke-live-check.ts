/**
 * Revocation, end to end, against the real registry.
 *
 *   bun packages/ens/revoke-live-check.ts
 *
 * This is the claim the whole ENS integration rests on: revoking a name stops
 * the spending. Everything else — the hierarchy, the records, the guard — is
 * machinery in service of that one sentence, and it is the sentence most easily
 * asserted without being true. So it is done for real: a name is minted, an
 * allowance spends through the authority, the name is withdrawn on chain, and
 * the same allowance is refused.
 *
 * It spends testnet gas and leaves nothing behind — the name it mints is the
 * name it revokes.
 *
 * The authority here is real; only the signer is not. Whether a Hedera payment
 * would have succeeded is a different question, answered elsewhere; what is
 * being checked is that identity gates it.
 */
import {
  createEnsClient,
  ensNameGuard,
  ensureAgentName,
  openEnsSigner,
  registryOf,
  revokeAgentName,
  ROOT_NAME,
} from './src/index';
import { createAuthority, type PaymentRequirements, type PaymentSigner } from '../sdk/src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const LABEL = `revoke-probe-${Math.floor(Date.now() / 1000) % 100000}`;
const NETWORK = 'hedera:testnet';

const signed: string[] = [];
const signer: PaymentSigner = {
  network: NETWORK,
  accountId: '0.0.1001',
  async createPayload(_version, requirements: PaymentRequirements) {
    signed.push(requirements.amount);
    return { transaction: `signed:${requirements.amount}` };
  },
};

const quote = (amount: string): PaymentRequirements => ({
  scheme: 'exact',
  network: NETWORK,
  amount,
  asset: '0.0.0',
  payTo: '0.0.2002',
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.7162784' },
});

const ens = openEnsSigner();
const clients = { public: ens.public, wallet: ens.wallet };

console.log('\n  Revocation, end to end\n');
console.log(`  minting  ${LABEL}.${ROOT_NAME}`);

const agent = await ensureAgentName(clients, {
  label: LABEL,
  parent: ROOT_NAME,
  owner: ens.address,
  grantedMinor: 10_000n,
});
check(agent.minted, 'a fresh name was minted', agent.name);

/*
  A guard with no cache. Thirty seconds of believing a resolving name is right
  in production and useless here, where the whole point is to observe the
  moment the answer changes.
*/
const guard = ensNameGuard({ ttlMs: 0 });

const authority = await createAuthority({
  signer,
  secret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  fundedMinor: 100_000n,
  names: guard,
});

const granted = await authority.mint({
  parent: authority.rootToken,
  child: agent.name,
  amountMinor: 10_000n,
  expiresAt: Date.now() + 60 * 60 * 1000,
});
const opened = await authority.open(granted.capability);

const spend = () =>
  authority.authorize({
    token: opened.token,
    policy: opened.policy,
    x402Version: 2,
    requirements: quote('1000'),
  });

const before = await spend();
check(before.remainingMinor === 9_000n, 'while the name resolves, the allowance spends');
check(signed.length === 1, 'and the signer was actually reached');

console.log(`\n  revoking ${agent.name} on chain…`);
const parentRegistry = (await registryOf(ens.public, ROOT_NAME))!;
const hash = await revokeAgentName(clients, {
  parentRegistry,
  label: LABEL,
  name: agent.name,
  resolver: agent.resolver,
});
console.log(`  ${hash}`);

const resolvedAfter = await createEnsClient().addressOf(agent.name);
check(resolvedAfter === null, 'the name no longer resolves', resolvedAfter ?? '');

let refusal = '';
try {
  await spend();
} catch (error) {
  refusal = (error as { code?: string }).code ?? (error as Error).message;
}
check(refusal === 'name_not_resolving', 'and the same allowance is now refused', refusal);
check(signed.length === 1, 'nothing further was signed');

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
