/**
 * The ENSv2 deployment this project talks to.
 *
 * ENSv2's hackathon deployment is *not* the ENSv2 beta deployment, and neither
 * is what viem resolves against by default. viem ships mainnet's Universal
 * Resolver and will happily answer with it, so a name that does not exist on
 * mainnet comes back as "not found" rather than as "you asked the wrong
 * contract" — a failure that looks like a missing name and is actually a
 * missing override. Everything here exists so that override is stated once, in
 * a file whose name says what it is.
 *
 * Addresses come from the deployment table published for the event. They are
 * checksummed on the way in rather than pasted as lowercase hex, because viem
 * rejects a malformed address at call time and a typo in a constant should not
 * survive until then.
 *
 * @see https://feature-permres-inode-refact.docs-bao.pages.dev/learn/deployments
 */
import { getAddress, type Address } from 'viem';

/** CAIP-2 for the chain the ENSv2 hackathon deployment lives on. */
export const ENS_NETWORK = 'eip155:11155111';
export const ENS_CHAIN_ID = 11155111;

/**
 * The contracts this project actually calls.
 *
 * A subset, deliberately. The deployment publishes forty-odd addresses; the
 * ones absent here are absent because nothing in this codebase has a reason to
 * call them, and an unused constant is a claim that something does.
 */
export const ENS = {
  /**
   * Resolution's single entry point. Walks the registry hierarchy and returns
   * the deepest resolver found — the contract that makes a name a name.
   *
   * The proxy rather than the implementation: it is what the deployment's own
   * app points at, so an upgrade behind it is not a change here.
   */
  universalResolver: getAddress('0xd26f2040d083af1cd2962ba303f4bea0c4faf142'),
  /** `.eth` itself. Parent of every name this project registers. */
  ethRegistry: getAddress('0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e'),
  /** Commit-reveal registration for `.eth`, paid in an ERC-20. */
  ethRegistrar: getAddress('0x7d1b7f586a62ac3f54b9a396849757814283270b'),
  /** The shared resolver, for names that do not need one of their own. */
  publicResolver: getAddress('0xf9de4979ddb290baf5b760d0e788125017bc33f6'),
  /**
   * Deploys the registry a name owns.
   *
   * This is the contract that makes the design ENSv2-shaped rather than
   * ENSv1-with-extra-labels: a name's subnames live in a registry that name
   * owns, so an agent handing out allowances to sub-agents is handing out
   * entries in its own registry rather than rows in ours.
   */
  verifiableFactory: getAddress('0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780'),
  /** The registry implementation that factory deploys behind a proxy. */
  userRegistryImpl: getAddress('0x47b442d0cf617c41cabaff5f02f44dd1e5f72546'),
  /**
   * The resolver implementation, deployed per account.
   *
   * `publicResolver` above is shared and refuses writes from an ordinary
   * account — every setter reverts, which reads like a wrong signature and is
   * actually a missing permission. An account writes records by deploying one
   * of these and pointing its names at it.
   */
  permissionedResolverImpl: getAddress('0xa9d3814ab151bf6e37a427432795371a8361614e'),
  /** What registration is paid in on this deployment. Mintable by anyone. */
  usdc: getAddress('0xcbfd80f74375c54e545af34788ff465f96f66f05'),
} as const satisfies Record<string, Address>;

/**
 * Our own contract, kept apart from the deployment's.
 *
 * Everything in `ENS` above came from the event's published table. This one was
 * compiled from `contracts/Batch7702.sol` and deployed by
 * `deploy-batcher.ts` — the code an account runs when an EIP-7702
 * authorization makes a mint one transaction instead of seven.
 *
 * A constant rather than configuration, because it is a public address on a
 * public chain and nothing about it is per-install. `ENS_BATCHER` overrides it
 * for anyone who would rather run their own, and `ENS_BATCHER=off` turns
 * batching off; unset, batching works out of the box.
 *
 * Do not point an account at a delegate that is not this one without reading
 * `Batch7702.sol` first. A delegated account has code, and ENSv2 mints names
 * with `_safeMint` — a delegate lacking `onERC1155Received` leaves the account
 * unable to be given a name at all. That is not a hypothetical; the first
 * version of this contract had exactly that hole.
 */
export const BATCH_7702 = getAddress('0x99ce6fd1e6bf225c6b006f02fabb7c2eecb83bbd');

/**
 * Where a human looks at what this code did.
 *
 * Worth keeping beside the addresses: a registration that succeeded on chain
 * and cannot be seen in an app is indistinguishable, to anyone watching a
 * demo, from one that did not happen.
 */
export const ENS_APP = 'https://hackathon-deployment-manager-app-v4.ens-cf.workers.dev/';
export const ENS_EXPLORER = 'https://hackathon-deployment-portal-app.ens-cf.workers.dev/';

/** Public Sepolia RPC. Reads and writes both go here. */
export const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
