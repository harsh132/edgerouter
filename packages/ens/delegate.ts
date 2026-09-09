/**
 * Points the account's EIP-7702 delegation somewhere, or nowhere.
 *
 *   bun packages/ens/delegate.ts                 # to the configured batcher
 *   bun packages/ens/delegate.ts --to 0x…        # to something else
 *   bun packages/ens/delegate.ts --clear         # back to a plain EOA
 *
 * Deliberately its own command. `sendCalls` will install a delegation on an
 * account that has none, because that is the account agreeing to run code it is
 * about to use — but it refuses to *replace* one, since something other than
 * this codebase may have put it there and silently overwriting another
 * application's delegate is how an account stops working for reasons nobody can
 * find. Replacing is a decision, so it gets a command.
 *
 * `--clear` matters more than it looks. A delegated account has code, and code
 * changes how other contracts treat it: ENSv2 mints names with `_safeMint`, so
 * an account whose delegate does not implement `onERC1155Received` cannot be
 * given a name at all. This is the way back.
 */
import { formatEther, zeroAddress, type Address } from 'viem';
import { batchingState, delegateOf, openEnsSigner, BATCHER } from './src/index';

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const clear = process.argv.includes('--clear');
const target = (clear ? zeroAddress : ((flag('to') as Address | undefined) ?? BATCHER)) as Address | undefined;

const signer = openEnsSigner();
const clients = { public: signer.public, wallet: signer.wallet };
const say = (line = '') => console.log(line);

const before = await delegateOf(signer.public, signer.address);

say();
say(`  account    ${signer.address}`);
say(`  balance    ${formatEther(await signer.public.getBalance({ address: signer.address }))} ETH`);
say(`  delegate   ${before ?? 'none — a plain EOA'}`);

if (!target) {
  say('\n  no batcher configured and no --to given; nothing to point at.\n');
  process.exit(1);
}

if ((before ?? zeroAddress).toLowerCase() === target.toLowerCase()) {
  say(`\n  already ${clear ? 'a plain EOA' : `delegated to ${target}`}; nothing to do.\n`);
  process.exit(0);
}

say(`  setting    ${clear ? 'no delegation' : target}`);

/*
  `executor: 'self'` because this account both signs the authorization and sends
  the transaction that carries it, which means the authorization is signed
  against the next nonce rather than the current one. Get it wrong and the
  transaction is mined, succeeds, and changes nothing.
*/
const authorization = await signer.wallet.signAuthorization({
  account: signer.wallet.account!,
  contractAddress: target,
  executor: 'self',
});

const hash = await signer.wallet.sendTransaction({
  account: signer.wallet.account!,
  chain: signer.wallet.chain!,
  to: signer.address,
  data: '0x',
  authorizationList: [authorization],
});
say(`  sent       ${hash}`);

await signer.public.waitForTransactionReceipt({ hash });

/*
  Read back rather than trusted. An authorization with the wrong nonce produces
  a perfectly successful transaction that installs nothing, which is the single
  most confusing way this can fail.
*/
const after = await delegateOf(signer.public, signer.address);
say(`  delegate   ${after ?? 'none — a plain EOA'}`);
say(`  batching   ${await batchingState(clients)}`);
say(
  after?.toLowerCase() === target.toLowerCase() || (clear && after === null)
    ? '\n  Done.\n'
    : '\n  The transaction succeeded but the delegation did not change. Check the nonce.\n',
);
