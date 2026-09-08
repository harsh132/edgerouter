/**
 * Gives edgerouter.eth its own resolver and its own registry.
 *
 *   bun packages/ens/setup-root.ts [name.eth]
 *
 * Run once, after the name is registered. Afterwards the name can hold records
 * this account may actually write, and agent names can be minted underneath it
 * without touching anything global.
 *
 * Idempotent by construction rather than by checking: both proxies are salted
 * by what they are for, so a second run would try to deploy to an address that
 * already exists and be refused by the simulation before spending gas.
 */
import { namehash } from 'viem/ens';
import {
  ENS,
  ENS_APP,
  attachToName,
  createEnsClient,
  deployRegistry,
  deployResolver,
  describeAgent,
  openEnsSigner,
  registrySaltFor,
  resolverSaltFor,
} from './src/index';

const name = process.argv[2] ?? 'edgerouter.eth';
const label = name.replace(/\.eth$/, '');
const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const say = (line = '') => console.log(line);

say(`\n  name       ${name}`);
say(`  owner      ${signer.address}`);
say(`  node       ${namehash(name)}`);
say(`  salts      resolver ${resolverSaltFor(signer.address).toString(16).slice(0, 12)}…`);
say(`             registry ${registrySaltFor(name).toString(16).slice(0, 12)}…`);

const resolver = await deployResolver(clients, { owner: signer.address });
say(`\n  resolver   ${resolver.address}`);
say(`             ${resolver.hash ?? 'already deployed'}`);

const registry = await deployRegistry(clients, { name });
say(`  registry   ${registry.address}`);
say(`             ${registry.hash ?? 'already deployed'}`);

const attached = await attachToName(clients, {
  registry: ENS.ethRegistry,
  label,
  resolver: resolver.address,
  subregistry: registry.address,
});
say(`\n  setResolver     ${attached.resolverHash}`);
say(`  setSubregistry  ${attached.subregistryHash}`);

/*
  The address record. Until this is written the name resolves to a resolver and
  no further, which is a name that exists and points at nothing.
*/
const described = await describeAgent(clients, {
  resolver: resolver.address,
  name,
  address: signer.address,
  gate: 'https://edgerouter-gate.prakashharsh32.workers.dev',
});
say(`
  setAddress      ${described.address}`);

/*
  Read back through the hierarchy rather than trusting the receipts: the calls
  succeeding and resolution working are different claims, and only the second
  one matters.
*/
const ens = createEnsClient();
say(`\n  resolves via    ${(await ens.resolverOf(name)) ?? 'nothing'}`);
say(`  subregistry     ${await signer.public.readContract({
  address: ENS.ethRegistry,
  abi: (await import('./src/abi')).registryAbi,
  functionName: 'getSubregistry',
  args: [label],
})}`);
say(`\n  manage     ${ENS_APP}\n`);
