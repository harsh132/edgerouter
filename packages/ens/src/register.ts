/**
 * Registering a `.eth` name, and paying for it.
 *
 * The name this project registers is the root every agent name hangs from, so
 * it is registered once and then mostly forgotten. What makes it worth its own
 * module is the commit-reveal dance, which is easy to get subtly wrong:
 *
 *   1. `commit(hash)` publishes a hash of the registration you intend to make
 *   2. wait at least `MIN_COMMITMENT_AGE` — sixty seconds on this deployment
 *   3. `register(...)` with the *same* arguments, which reveals them
 *
 * The point is front-running: between wanting a name and getting it, the
 * intention is public, and a hash is the only form of it that gives nothing
 * away. Two consequences fall out of that and both are load-bearing here.
 *
 * The secret must survive between the two calls, and the arguments must match
 * exactly — a different resolver, a duration off by a second, and the
 * commitment hashes differently, so `register` reverts with nothing useful to
 * say. That is why this module builds both calls from one object rather than
 * letting a caller pass the arguments twice.
 *
 * And the commitment expires. `MAX_COMMITMENT_AGE` is a day here, which is
 * generous, but a process that commits and then waits on a human has to be
 * assumed to have lost the race.
 *
 * ## Paying
 *
 * Registration is priced in an ERC-20, not in ether — on this deployment a
 * MockUSDC anyone can mint, which is why the fee costs nothing and the gas
 * still does. The token has to be approved before `register`, and the approval
 * has to cover `base + premium`: a name under premium decay costs more than its
 * base rate, and an approval sized to the base alone fails at the last step.
 */
import { keccak256, toHex, type Address, type Hash, type WalletClient } from 'viem';
import type { PublicClient } from 'viem';
import { ethRegistrarAbi, mockUsdcAbi } from './abi';
import { ENS } from './deployment';
import { ensName } from './client';

/** A year, in seconds. The unit `duration` is expressed in. */
export const YEAR_SECONDS = 31_536_000n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

export type RegistrationPlan = {
  /** The label alone — `edgerouter`, not `edgerouter.eth`. */
  label: string;
  owner: Address;
  /** Random, and the same value for both calls. Kept only in memory. */
  secret: Hash;
  /**
   * The registry that will own this name's subnames.
   *
   * Zero at registration: the registry is deployed afterwards and attached
   * with `setSubregistry`, because the factory needs the name's owner to exist
   * before it can grant it anything.
   */
  subregistry: Address;
  resolver: Address;
  durationSeconds: bigint;
  paymentToken: Address;
  /** What the whole thing costs, base plus premium, in the token's units. */
  priceMinor: bigint;
};

/** A secret nobody can guess and nothing else derives. */
const freshSecret = (): Hash => keccak256(toHex(crypto.getRandomValues(new Uint8Array(32))));

/**
 * Works out what registering a name would involve, without doing any of it.
 *
 * Separate from the act so a caller can show the price and the owner before
 * anything is signed — and so the refusal for an unavailable name happens
 * before a commitment is published rather than after.
 */
export const planRegistration = async (
  client: PublicClient,
  params: {
    label: string;
    owner: Address;
    durationSeconds?: bigint;
    resolver?: Address;
    paymentToken?: Address;
  },
): Promise<RegistrationPlan> => {
  // Normalised through the same path resolution uses: registering a label that
  // normalises to something else would register a name nobody can look up.
  const label = ensName(params.label);
  if (label.includes('.')) {
    throw new Error(`"${params.label}" is a name, not a label — pass "edgerouter", not "edgerouter.eth"`);
  }

  const available = await client.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'isAvailable',
    args: [label],
  });
  if (!available) throw new Error(`${label}.eth is already registered`);

  const durationSeconds = params.durationSeconds ?? YEAR_SECONDS;
  const paymentToken = params.paymentToken ?? ENS.usdc;

  const [base, premium] = await client.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'getRegisterPrice',
    args: [label, durationSeconds, paymentToken],
  });

  return {
    label,
    owner: params.owner,
    secret: freshSecret(),
    subregistry: ZERO_ADDRESS,
    resolver: params.resolver ?? ENS.publicResolver,
    durationSeconds,
    paymentToken,
    priceMinor: base + premium,
  };
};

const commitmentArgs = (plan: RegistrationPlan) =>
  [
    plan.label,
    plan.owner,
    plan.secret,
    plan.subregistry,
    plan.resolver,
    plan.durationSeconds,
    ZERO_BYTES32,
  ] as const;

/**
 * Publishes the commitment.
 *
 * Returns the hash so a caller can wait on it: `register` must not be sent
 * until this transaction is mined *and* `MIN_COMMITMENT_AGE` has passed since,
 * and the age is counted from the block, not from when this function returned.
 */
export const commit = async (
  clients: { public: PublicClient; wallet: WalletClient },
  plan: RegistrationPlan,
): Promise<{ hash: Hash; commitment: Hash; minAgeSeconds: number }> => {
  const commitment = await clients.public.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'makeCommitment',
    args: commitmentArgs(plan),
  });

  const minAge = await clients.public.readContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'MIN_COMMITMENT_AGE',
  });

  const hash = await clients.wallet.writeContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'commit',
    args: [commitment],
    account: clients.wallet.account!,
    chain: clients.wallet.chain!,
  });

  return { hash, commitment, minAgeSeconds: Number(minAge) };
};

/**
 * Makes sure the fee can actually be paid, minting and approving as needed.
 *
 * Both halves are conditional, because both are transactions: minting when the
 * balance already covers it would be noise on a chain someone is watching, and
 * re-approving an allowance that is already sufficient is a fee for nothing.
 */
export const ensureFunds = async (
  clients: { public: PublicClient; wallet: WalletClient },
  plan: RegistrationPlan,
): Promise<{ minted: Hash | null; approved: Hash | null }> => {
  const owner = plan.owner;
  const account = clients.wallet.account!;
  const chain = clients.wallet.chain!;

  let minted: Hash | null = null;
  const balance = await clients.public.readContract({
    address: plan.paymentToken,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [owner],
  });
  if (balance < plan.priceMinor) {
    /*
      Ten times the price rather than exactly it: this token exists to be
      minted, and a second registration should not need a second mint. Asking
      for exactly the fee also leaves nothing for the renewal.
    */
    minted = await clients.wallet.writeContract({
      address: plan.paymentToken,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [owner, plan.priceMinor * 10n],
      account,
      chain,
    });
    await clients.public.waitForTransactionReceipt({ hash: minted });
  }

  let approved: Hash | null = null;
  const allowance = await clients.public.readContract({
    address: plan.paymentToken,
    abi: mockUsdcAbi,
    functionName: 'allowance',
    args: [owner, ENS.ethRegistrar],
  });
  if (allowance < plan.priceMinor) {
    approved = await clients.wallet.writeContract({
      address: plan.paymentToken,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [ENS.ethRegistrar, plan.priceMinor * 10n],
      account,
      chain,
    });
    await clients.public.waitForTransactionReceipt({ hash: approved });
  }

  return { minted, approved };
};

/**
 * Reveals the commitment and takes the name.
 *
 * Every argument must be identical to the one the commitment was built from,
 * which is why this takes the plan rather than a list — the commitment is a
 * hash of exactly these values, and a mismatch reverts without saying which
 * field differed.
 */
export const register = async (
  clients: { public: PublicClient; wallet: WalletClient },
  plan: RegistrationPlan,
): Promise<{ hash: Hash }> => {
  const hash = await clients.wallet.writeContract({
    address: ENS.ethRegistrar,
    abi: ethRegistrarAbi,
    functionName: 'register',
    args: [
      plan.label,
      plan.owner,
      plan.secret,
      plan.subregistry,
      plan.resolver,
      plan.durationSeconds,
      plan.paymentToken,
      ZERO_BYTES32,
    ],
    account: clients.wallet.account!,
    chain: clients.wallet.chain!,
  });

  return { hash };
};
