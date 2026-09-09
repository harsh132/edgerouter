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

/** Decimal places, per network. The one fact both directions need. */
const decimalsOf = (network: string): number => (network.startsWith('hedera:') ? 8 : 6);

/**
 * The inverse of `formatAmount`: a written amount back into smallest units.
 *
 * Parsed by string rather than through a float, because `0.1` is not
 * representable in binary and `Number('0.07') * 1e8` is `7000000.000000001` —
 * which rounds to a different number of tinybars than the user typed. Money
 * that changes when it passes through a parser is not money anyone can audit.
 *
 * Throws on anything that is not a plain decimal. There is no sensible bigint
 * for "about a tenth", and guessing one costs whatever the guess was wrong by.
 */
export const parseAmount = (network: string, text: string): bigint => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`"${text}" is not an amount`);

  const decimals = decimalsOf(network);
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`${network} has ${decimals} decimal places; "${text}" has more`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
};

/** What the smallest unit is called here. For messages that name the unit. */
export const unitName = (network: string): string =>
  network.startsWith('hedera:') ? 'tinybars' : 'the asset’s smallest unit';
