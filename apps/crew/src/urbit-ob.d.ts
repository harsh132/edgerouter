/**
 * `urbit-ob` ships no types.
 *
 * Only one function is used and its contract is narrow — a number in the planet
 * range to the `~sampel-palnet` string that names it — so it is declared here
 * rather than pulling in an untyped module wholesale.
 */
declare module 'urbit-ob' {
  export function patp(value: number | string | bigint): string;
}
