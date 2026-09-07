/**
 * What a sensible per-call ceiling is, and how to show an amount, per network.
 *
 * Both exist for the same reason: "the smallest unit" is not one unit. A cap of
 * `100000000` is one hbar on Hedera and one hundred USDC on Base — the same
 * number, three orders of magnitude apart in what it permits. A single default
 * is therefore correct on at most one chain, and wrong in the expensive
 * direction on the others.
 *
 * So the default is a function of the network rather than a constant. An
 * explicit setting always wins; this only decides what "unset" means, and it
 * decides it in the direction that costs less to be wrong about.
 */
import { formatHbar, TINYBARS_PER_HBAR } from './hedera';
import { formatUsdc } from './evm';

/** One hbar. Roughly eight cents, and about eighty calls at current prices. */
const HEDERA_DEFAULT_MAX = TINYBARS_PER_HBAR;
/** 0.1 USDC. Ten cents, and about a hundred calls. */
const EVM_DEFAULT_MAX = 100_000n;

/**
 * The per-call ceiling to use when nobody has said.
 *
 * Deliberately small. A ceiling exists to bound the damage of a gate quoting
 * something absurd, so the default should be comfortably above a real price and
 * nowhere near a painful one — and a user who wants to spend more per call is
 * in a position to say so, while a user surprised by the default is not.
 */
export const defaultMaxAmount = (network: string): bigint =>
  network.startsWith('hedera:') ? HEDERA_DEFAULT_MAX : EVM_DEFAULT_MAX;

/**
 * Renders an amount in whatever unit the network actually uses.
 *
 * There is no neutral rendering. A bare integer of the smallest unit is
 * technically complete and useless to read, and picking one asset's formatter
 * for all of them is how "0.001 USDC" gets logged as "0.00000000001 ℏ".
 */
export const formatAmount = (network: string, minor: bigint): string =>
  network.startsWith('hedera:') ? formatHbar(minor) : formatUsdc(minor);

/** What the smallest unit is called here. For messages that name the unit. */
export const unitName = (network: string): string =>
  network.startsWith('hedera:') ? 'tinybars' : 'the asset’s smallest unit';
