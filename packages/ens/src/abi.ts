/**
 * The parts of the ENSv2 ABI this project calls.
 *
 * Written out rather than imported from a published artifact, because the
 * hackathon deployment has no package to import one from. Every signature here
 * was checked against the deployed contracts before being written down — the
 * cost of guessing is high and quiet: viem reports a selector that does not
 * exist and one that reverts with *the same message*, so a wrong signature
 * reads as a contract that refused rather than a function that is not there.
 *
 * Two traps worth naming, both of which cost time here:
 *
 *   `referrer` is `bytes32`, not an address. Passing an address encodes to
 *   twenty bytes and fails inside viem, which is the lucky case; the unlucky
 *   one is a signature that encodes fine and hashes to a different selector.
 *
 *   `getRegisterPrice` returns *two* words, `base` and `premium`. Decoding it
 *   as a single `uint256` succeeds and silently yields the base alone, which is
 *   right up until a name carries a premium and the approval is too small.
 */
import { parseAbi } from 'viem';

export const ethRegistrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)',
  'function renew(string label, uint64 duration, address paymentToken, bytes32 referrer)',
  'function MIN_COMMITMENT_AGE() view returns (uint256)',
  'function MAX_COMMITMENT_AGE() view returns (uint256)',
]);

/**
 * The three functions that make a registry a registry.
 *
 * Resolution walks these: `getSubregistry` points down the hierarchy and
 * `getResolver` says which contract holds the records. Everything else about a
 * registry is a matter of who may write to it.
 */
export const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getParent() view returns (address parent, string label)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expires) returns (uint256 tokenId)',
  'function unregister(uint256 anyId)',
  'function setResolver(uint256 anyId, address resolver)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function grantRoles(uint256 anyId, uint256 roleBitmap, address account)',
  'function ownerOf(uint256 id) view returns (address)',
]);

/** MockUSDC. Anyone may mint, which is what makes registration free here. */
export const mockUsdcAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/** Records, as written on a resolver this project controls. */
export const resolverAbi = parseAbi([
  'function setAddr(bytes32 node, address addr)',
  'function setText(bytes32 node, string key, string value)',
  'function addr(bytes32 node) view returns (address)',
  'function text(bytes32 node, string key) view returns (string)',
]);
