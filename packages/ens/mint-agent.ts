/**
 * Mints a name for a session or a sub-agent.
 *
 *   bun packages/ens/mint-agent.ts session-demo --parent edgerouter.eth --subdelegate
 *   bun packages/ens/mint-agent.ts researcher --parent session-demo.edgerouter.eth --budget 50000000
 *
 * The parent's registry is looked up rather than passed: a name's subregistry
 * is on chain, and asking for it is how this stays honest about where a name
 * is actually being minted.
 */
import { formatUnits } from 'viem';
import { ENS, createEnsClient, mintAgentName, openEnsSigner, parentOf, registryAbi, RECORD } from './src/index';

const label = process.argv[2];
if (!label) {
  console.error('\n  usage: bun packages/ens/mint-agent.ts <label> [--parent name.eth] [--budget minor] [--subdelegate]\n');
  process.exit(1);
}
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const parent = flag('parent') ?? 'edgerouter.eth';
const budget = flag('budget');
const subdelegate = process.argv.includes('--subdelegate');

const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const say = (line = '') => console.log(line);

/*
  Which registry the parent owns. A zero here means the parent cannot hold
  subnames at all, which is a clearer thing to say than letting `register`
  revert against the zero address.
*/
const parentLabel = parent.replace(/\.eth$/, '').split('.').reverse()[0]!;
const parentRegistry =
  parent === 'edgerouter.eth'
    ? await signer.public.readContract({
        address: ENS.ethRegistry,
        abi: registryAbi,
        functionName: 'getSubregistry',
        args: [parentLabel],
      })
    : await (async () => {
        const chain = parent.replace(/\.eth$/, '').split('.').reverse();
        let registry = await signer.public.readContract({
          address: ENS.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [chain[0]!],
        });
        for (const step of chain.slice(1)) {
          registry = await signer.public.readContract({
            address: registry, abi: registryAbi, functionName: 'getSubregistry', args: [step],
          });
        }
        return registry;
      })();

if (parentRegistry === '0x0000000000000000000000000000000000000000') {
  console.error(`\n  ${parent} owns no registry, so nothing can be minted under it.`);
  console.error('  Mint it with --subdelegate, or use a parent that can hold subnames.\n');
  process.exit(1);
}

say(`\n  minting    ${label}.${parent}`);
say(`  registry   ${parentRegistry}`);

const agent = await mintAgentName(clients, {
  label,
  parent,
  parentRegistry,
  owner: signer.address,
  subdelegate,
  ...(budget ? { grantedMinor: BigInt(budget), asset: 'hedera:testnet/native' } : {}),
});

say(`  name       ${agent.name}`);
say(`  registered ${agent.registerHash ?? 'already existed'}`);
say(`  resolver   ${agent.resolver}`);
say(`  registry   ${agent.registry === '0x0000000000000000000000000000000000000000' ? 'none — cannot sub-delegate' : agent.registry}`);

const ens = createEnsClient();
say(`\n  resolves to  ${(await ens.addressOf(agent.name)) ?? 'nothing yet'}`);
if (budget) say(`  granted      ${formatUnits(BigInt(budget), 8)} (${await ens.textOf(agent.name, RECORD.granted)} minor)`);
say(`  parent       ${parentOf(agent.name) ?? 'none — this is a root'}`);
