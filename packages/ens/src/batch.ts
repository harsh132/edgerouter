/**
 * Seven transactions, one receipt.
 *
 * Minting a name is a sequence of writes from one account to two contracts:
 * `register` in the parent's registry, then an address record, then a text
 * record per thing the name says. Each was its own transaction awaiting its own
 * receipt, so a hire cost seven Sepolia blocks — over a minute of a button
 * saying "Minting…" — and could be interrupted halfway, which is not
 * hypothetical: a mint killed between `register` and `setAddress` once left a
 * name registered, resolving to nothing, invisible to the app and impossible to
 * mint again.
 *
 * EIP-7702 fixes both. An authorization installs `Batch7702` as the account's
 * code, and a transaction the account sends to itself then runs every call in
 * one block, atomically.
 *
 * ## Why not a multicall contract
 *
 * Because `msg.sender` is the whole problem. The registry checks role bitmaps
 * against its caller and the resolver checks ownership the same way, so a
 * helper contract calling on the account's behalf arrives as itself and is
 * refused. The fix would be granting that helper the roles — which is handing a
 * contract standing authority over `edgerouter.eth`, permanently, to save some
 * latency. Under 7702 the code runs *as* the account: `address(this)` is the
 * EOA, so every inner call still has the EOA as `msg.sender`, and the contract
 * holds no authority of its own at all.
 *
 * ## What the delegation is worth to an attacker
 *
 * Nothing, which is the point of `Batch7702` being seven lines. Its `execute`
 * reverts unless `msg.sender == address(this)`, and the only way to satisfy
 * that is a transaction signed by the account's own key. Delegation therefore
 * grants no capability the key did not already have. This is worth being
 * precise about because the usual 7702 failure is the opposite: a delegate with
 * an unauthenticated entry point turns an EOA into a contract anyone may spend
 * from.
 *
 * ## Falling back
 *
 * Everything here is optional. `sendCalls` sends the calls one at a time when
 * no batcher is deployed, when the account is delegated to something else, or
 * when the chain rejects the transaction type — so an install with no
 * delegation behaves exactly as it did before, only slower.
 */
import { encodeFunctionData, parseAbi, type Address, type Hash, type Hex } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { BATCH_7702 } from './deployment';

/** One contract call, before anyone has decided how it will be sent. */
export type Call = { to: Address; data: Hex; value?: bigint };

export const batcherAbi = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'function execute(Call[] calls) payable',
]);

/**
 * The batcher this account delegates to.
 *
 * Defaults to the one deployed from `contracts/Batch7702.sol`, so batching is
 * on without configuration. `ENS_BATCHER` points it elsewhere, and setting it
 * to `off` turns batching off entirely — worth having, because "send these one
 * at a time" is the first thing to try when a mint behaves strangely.
 */
export const BATCHER: Address | undefined =
  process.env.ENS_BATCHER === 'off' ? undefined : ((process.env.ENS_BATCHER as Address | undefined) ?? BATCH_7702);

/** EIP-7702's marker. An account's code is this, then the delegate's address. */
const DELEGATION_PREFIX = '0xef0100';

/**
 * What an account currently runs, if anything.
 *
 * A delegated EOA's code is exactly 23 bytes: `0xef0100` and an address. Any
 * other code means a real contract, which is not something to send an
 * authorization to, and no code means a plain EOA.
 */
export const delegateOf = async (client: PublicClient, account: Address): Promise<Address | null> => {
  const code = await client.getCode({ address: account });
  if (!code || !code.startsWith(DELEGATION_PREFIX) || code.length !== 48) return null;
  return `0x${code.slice(DELEGATION_PREFIX.length)}` as Address;
};

type Clients = { public: PublicClient; wallet: WalletClient };

/**
 * Whether this account can batch right now, and what it would take.
 *
 * Three answers rather than a boolean, because "not delegated yet" and
 * "delegated to somebody else's contract" call for different behaviour: the
 * first is fixed by attaching an authorization to the next transaction, and the
 * second must not be overwritten, since something other than this codebase put
 * it there.
 */
export const batchingState = async (
  clients: Clients,
  batcher: Address | undefined = BATCHER,
): Promise<'ready' | 'needs-authorization' | 'unavailable'> => {
  if (!batcher) return 'unavailable';
  const account = clients.wallet.account?.address;
  if (!account) return 'unavailable';

  const current = await delegateOf(clients.public, account);
  if (current === null) {
    /*
      No delegation, or a real contract. `getCode` returning something that is
      not a delegation designation means this address is not an EOA at all, and
      an authorization would be meaningless.
    */
    const code = await clients.public.getCode({ address: account });
    return code && code !== '0x' ? 'unavailable' : 'needs-authorization';
  }
  return current.toLowerCase() === batcher.toLowerCase() ? 'ready' : 'unavailable';
};

/**
 * Sends calls as one transaction when it can, and as several when it cannot.
 *
 * The authorization rides along with the first batch rather than being sent on
 * its own, which is why hiring the first agent is not slower than hiring the
 * second: EIP-7702 lets a transaction install the code it is about to run.
 * `executor: 'self'` tells viem the account sending the transaction is the one
 * being delegated, so the authorization is signed against the next nonce rather
 * than the current one — get that wrong and the transaction is mined with the
 * authorization silently ignored, which looks exactly like a batcher that does
 * not work.
 *
 * Returns every hash it produced: one when batched, one per call otherwise.
 *
 * A fallback is announced rather than swallowed. Silence here cost real time: a
 * mint that quietly went back to seven transactions is indistinguishable from
 * one that never tried, and the live check reported "not delegated" without
 * ever saying why the batch had been refused.
 */
export const sendCalls = async (
  clients: Clients,
  calls: Call[],
  options: { batcher?: Address | undefined; onFallback?: (why: string) => void } = {},
): Promise<Hash[]> => {
  if (calls.length === 0) return [];

  const batcher = options.batcher ?? BATCHER;
  const fellBack =
    options.onFallback ??
    ((why: string) => console.warn(`  batching off, sending ${calls.length} transactions instead: ${why}`));
  const account = clients.wallet.account!;
  const chain = clients.wallet.chain!;

  /*
    A single call is sent as a single call. Wrapping one write in a batch costs
    the calldata of the wrapper and buys nothing, and it keeps the revert data
    as the contract's own rather than as something re-thrown through `execute`.
  */
  if (calls.length > 1 && batcher) {
    const state = await batchingState(clients, batcher);
    if (state === 'unavailable') {
      fellBack('this account is not delegated to the batcher');
    } else {
      try {
        const data = encodeFunctionData({
          abi: batcherAbi,
          functionName: 'execute',
          args: [calls.map((call) => ({ to: call.to, value: call.value ?? 0n, data: call.data }))],
        });

        const authorizationList =
          state === 'needs-authorization'
            ? [await clients.wallet.signAuthorization({ account, contractAddress: batcher, executor: 'self' })]
            : [];

        const hash = await clients.wallet.sendTransaction({
          account,
          chain,
          to: account.address,
          data,
          ...(authorizationList.length > 0 ? { authorizationList } : {}),
        });
        await clients.public.waitForTransactionReceipt({ hash });
        return [hash];
      } catch (error) {
        /*
          A chain without Pectra, an RPC that will not accept a type-4
          transaction, or a call that would have reverted anyway. The first two
          are worth retrying sequentially; the third will fail again and say so
          properly, one call at a time, which is the better error message.
        */
        fellBack((error as Error).message.split('\n')[0] ?? 'the batch was refused');
      }
    }
  }

  const hashes: Hash[] = [];
  for (const call of calls) {
    const hash = await clients.wallet.sendTransaction({
      account,
      chain,
      to: call.to,
      data: call.data,
      ...(call.value ? { value: call.value } : {}),
    });
    await clients.public.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
};
