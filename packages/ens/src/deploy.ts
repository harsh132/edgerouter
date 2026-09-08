/**
 * Giving a name its own resolver and its own registry.
 *
 * This is the part that makes the design ENSv2-shaped rather than ENSv1 with
 * longer labels. In v1 every subname is a row in one global registry. In v2 a
 * name can *own a registry*, and subnames live inside it — so `edgerouter.eth`
 * holds the registry that agent names are minted from, and each agent name can
 * in turn hold the registry its sub-agents are minted from. The delegation tree
 * and the name hierarchy become the same tree.
 *
 * Both the resolver and the registry are UUPS proxies deployed through the
 * Verifiable Factory, which is what makes their addresses derivable rather than
 * remembered: the salt is a hash of what the thing is *for*, so the resolver
 * for an account and the registry for a name can be recomputed by anyone who
 * knows the account or the name.
 *
 * ## Role bitmaps are nibble-aligned
 *
 * Established the hard way, against the deployed contracts. A bitmap of all
 * ones is rejected with a custom error that appears in no public signature
 * database; so is the low 128 bits, and so is `0xffffffff`. What is accepted is
 * a bitmap whose set bits all sit at positions divisible by four —
 * `0x1111…1111` grants every role slot and validates, which is why the constant
 * below is written the way it is rather than as `type(uint256).max`.
 *
 * Getting this wrong costs a reverted deployment and no explanation, so the
 * shape is asserted in `deploy-check` rather than left as a comment.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { namehash } from 'viem/ens';
import { ENS } from './deployment';
import { registryAbi } from './abi';
import { ensName } from './client';

/**
 * Every role slot, and nothing that is not a role slot.
 *
 * One bit per nibble. See the note above: this is not a stylistic choice, it is
 * the only broad bitmap the contracts accept.
 */
export const ALL_ROLES = (() => {
  let mask = 0n;
  for (let i = 0; i < 64; i += 1) mask |= 1n << BigInt(i * 4);
  return mask;
})();

/** True when a bitmap could be a valid set of roles. */
export const isRoleBitmap = (bitmap: bigint): boolean => (bitmap & ~ALL_ROLES) === 0n;

const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
]);

const resolverInitAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants, bytes[] calls)',
]);

/**
 * One resolver per account.
 *
 * Salted by the account rather than by the name, which is the deployment's own
 * scheme: an account has one resolver and points as many names at it as it
 * likes. That is also why redeploying is not a worry — the same account and
 * version always yield the same address.
 */
export const resolverSaltFor = (owner: Address, version = 0n): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [keccak256(stringToHex('OwnedResolver')), owner, version],
      ),
    ),
  );

/** One subname registry per name. */
export const registrySaltFor = (name: string, version = 0n): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [keccak256(stringToHex('UserRegistry')), namehash(ensName(name)), version],
      ),
    ),
  );

type Clients = { public: PublicClient; wallet: WalletClient };

/**
 * What the factory announces when it deploys something.
 *
 * Needed because the factory refuses to redeploy at a salt it has already used
 * — correct, and it means a second run cannot learn the address the ordinary
 * way. The event is the only record that survives, so `deployOrFind` reads it
 * rather than treating "already deployed" as a failure.
 */
const proxyDeployedEvent = parseAbi([
  'event ProxyDeployed(address indexed deployer, address indexed proxy, uint256 salt, address implementation)',
])[0];

/** How far back to look for a proxy this account already deployed. */
const LOOKBACK_BLOCKS = 50_000n;

const findExistingProxy = async (
  clients: Clients,
  params: { salt: bigint; deployer: Address },
): Promise<Address | null> => {
  const head = await clients.public.getBlockNumber();
  const logs = await clients.public.getLogs({
    address: ENS.verifiableFactory,
    event: proxyDeployedEvent,
    args: { deployer: params.deployer },
    fromBlock: head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n,
    toBlock: head,
  });

  // Newest first: a redeployed salt would appear more than once, and the last
  // one is the live proxy.
  for (const log of logs.reverse()) {
    if (log.args.salt === params.salt) return log.args.proxy ?? null;
  }
  return null;
};

/**
 * Deploys through the factory, returning the address before spending anything.
 *
 * The simulation is not a nicety: a proxy that already exists at this salt
 * reverts, and so does a malformed role bitmap, and both are cheaper to learn
 * about from a call than from a receipt.
 */
const deployProxy = async (
  clients: Clients,
  params: { implementation: Address; salt: bigint; data: `0x${string}` },
): Promise<{ address: Address; hash: Hash | null }> => {
  const deployer = clients.wallet.account!.address;

  try {
    const { result, request } = await clients.public.simulateContract({
      address: ENS.verifiableFactory,
      abi: factoryAbi,
      functionName: 'deployProxy',
      args: [params.implementation, params.salt, params.data],
      account: clients.wallet.account!,
    });

    const hash = await clients.wallet.writeContract(request);
    await clients.public.waitForTransactionReceipt({ hash });
    return { address: result, hash };
  } catch (error) {
    /*
      The salt may simply be taken — by an earlier run of this same script,
      which is the expected case rather than an error. Anything else is a real
      failure and is re-thrown with the original message intact.
    */
    const existing = await findExistingProxy(clients, { salt: params.salt, deployer });
    if (existing) return { address: existing, hash: null };
    throw error;
  }
};

/** Deploys the caller's own resolver, which it may actually write records to. */
export const deployResolver = async (
  clients: Clients,
  options: { owner: Address; version?: bigint } = { owner: '0x' as Address },
): Promise<{ address: Address; hash: Hash | null }> =>
  deployProxy(clients, {
    implementation: ENS.permissionedResolverImpl,
    salt: resolverSaltFor(options.owner, options.version ?? 0n),
    data: encodeFunctionData({
      abi: resolverInitAbi,
      functionName: 'initialize',
      args: [[{ account: options.owner, roleBitmap: ALL_ROLES }], []],
    }),
  });

const registryInitAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants)',
]);

/**
 * Deploys the registry that will hold one name's subnames.
 *
 * The initialiser takes grants and nothing else. The published guide describes
 * `initialize(address rootAccount, uint256 roleBitmap)`, and that function is
 * on no contract in this deployment — every plausible two-argument form was
 * checked against the bytecode before this one was found. The difference is not
 * cosmetic: deploying with the documented data reverts, and deploying with
 * *empty* data succeeds and yields a registry nobody holds a role on, which is
 * worse. Such a registry accepts no `register`, cannot be granted roles
 * afterwards, and burns its salt permanently — the name it was deployed for
 * needs a new version to get a usable one.
 *
 * So the grant is made here, at deployment, where it is the only chance to
 * make it.
 */
export const deployRegistry = async (
  clients: Clients,
  options: { name: string; owner: Address; version?: bigint },
): Promise<{ address: Address; hash: Hash | null }> =>
  deployProxy(clients, {
    implementation: ENS.userRegistryImpl,
    salt: registrySaltFor(options.name, options.version ?? 0n),
    data: encodeFunctionData({
      abi: registryInitAbi,
      functionName: 'initialize',
      args: [[{ account: options.owner, roleBitmap: ALL_ROLES }]],
    }),
  });

/**
 * Points a name at a resolver and a registry.
 *
 * `anyId` takes a labelhash here — the registry accepts a labelhash, a token
 * id, or a resource interchangeably, and a labelhash is the one a caller can
 * compute without having watched the registration.
 */
export const attachToName = async (
  clients: Clients,
  options: { registry: Address; label: string; resolver?: Address; subregistry?: Address },
): Promise<{ resolverHash: Hash | null; subregistryHash: Hash | null }> => {
  const anyId = BigInt(keccak256(stringToHex(ensName(options.label))));
  const account = clients.wallet.account!;
  const chain = clients.wallet.chain!;

  let resolverHash: Hash | null = null;
  if (options.resolver) {
    resolverHash = await clients.wallet.writeContract({
      address: options.registry,
      abi: registryAbi,
      functionName: 'setResolver',
      args: [anyId, options.resolver],
      account,
      chain,
    });
    await clients.public.waitForTransactionReceipt({ hash: resolverHash });
  }

  let subregistryHash: Hash | null = null;
  if (options.subregistry) {
    subregistryHash = await clients.wallet.writeContract({
      address: options.registry,
      abi: registryAbi,
      functionName: 'setSubregistry',
      args: [anyId, options.subregistry],
      account,
      chain,
    });
    await clients.public.waitForTransactionReceipt({ hash: subregistryHash });
  }

  return { resolverHash, subregistryHash };
};
