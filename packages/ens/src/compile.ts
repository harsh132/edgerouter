/**
 * Compiling `Batch7702.sol`, here rather than in a build step.
 *
 * The alternative was to commit the creation bytecode as a hex constant, and
 * that is exactly the artefact nobody can check: a blob in a diff that claims
 * to be the contract beside it. This account is going to run whatever is at
 * that address as itself, so "trust the hex" is the wrong trade for the sake of
 * skipping a compile that takes a second.
 *
 * Only the deploy script calls this. Nothing at runtime needs a compiler.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import solc from 'solc';

const SOURCE = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'contracts');

export type Compiled = { abi: unknown[]; bytecode: `0x${string}`; solc: string };

/**
 * Optimised for size and for the shape of the thing: `execute` is called once
 * per mint, so the runs count is low and the bytecode is small. Determinism
 * matters more than either — the same source and the same settings have to
 * produce the same address, or redeploying stops being a no-op.
 */
export const compileBatcher = (): Compiled => {
  const name = 'Batch7702.sol';
  const input = {
    language: 'Solidity',
    sources: { [name]: { content: readFileSync(join(SOURCE, name), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'prague',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
  };

  const fatal = (output.errors ?? []).filter((problem) => problem.severity === 'error');
  if (fatal.length > 0) throw new Error(fatal.map((problem) => problem.formattedMessage).join('\n'));

  const contract = output.contracts[name]?.Batch7702;
  if (!contract) throw new Error('Batch7702 did not come out of the compiler');

  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
    solc: solc.version(),
  };
};
