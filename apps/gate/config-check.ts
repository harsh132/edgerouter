/**
 * The deployed configuration, checked against the parser that will read it.
 *
 * `check.ts` proves `parseNetworks` behaves correctly on fixtures. That is not
 * the same as proving the gate is configured correctly, and the gap between
 * those two has a specific shape: `parseNetworks` *drops* a malformed network
 * rather than throwing, because a half-configured network must never produce a
 * quote. Excellent behaviour at runtime, and it means a typo in `wrangler.jsonc`
 * removes a network silently — the gate deploys, answers, and simply refuses a
 * chain you believe you support.
 *
 * So this reads the real file, hands the real string to the real parser, and
 * asserts that what survives is what was written.
 *
 *   bun apps/gate/config-check.ts
 */
import { readFileSync } from 'node:fs';
import { parseNetworks, isEvmAddress, isEntityId } from './src/networks';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};

/**
 * Strips comments from JSONC.
 *
 * Deliberately crude, and safe here because it runs over one file we control:
 * it removes `//` to end of line when not inside a string. A real JSONC parser
 * would be a dependency for one file read by one script.
 */
const stripComments = (text: string): string => {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  // Trailing commas are legal in JSONC and not in JSON. Removed after comment
  // stripping, because a comment can sit between the comma and the brace.
  return out.replace(/,(\s*[}\]])/g, '$1');
};

const path = new URL('./wrangler.jsonc', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const config = JSON.parse(stripComments(readFileSync(path, 'utf8'))) as {
  vars?: Record<string, string>;
};
const vars = config.vars ?? {};

console.log(`\nDeployed configuration (${path})\n`);

/*
  The declared entries, read straight out of the file rather than restated
  here. Restating them would mean this check passes when the two agree with
  each other and disagree with reality.
*/
const declared = JSON.parse(vars.NETWORKS ?? '[]') as Record<string, unknown>[];
const parsed = parseNetworks(vars.NETWORKS);

check(declared.length > 0, `${declared.length} networks are declared`);
check(
  parsed.size === declared.length,
  `all ${declared.length} survive parsing (${parsed.size} did) — a dropped one is a silent typo`,
);

for (const entry of declared) {
  const id = String(entry.id);
  const network = parsed.get(id);
  if (!network) {
    check(false, `${id} was dropped by the parser`);
    continue;
  }

  check(network.payTo === entry.payTo, `${id} pays to the address in the file`);

  /*
    The failure this exists for. A zero payTo settles perfectly and destroys
    the payment: the client signs, the facilitator confirms, and the money is
    at an address nobody holds a key to.
  */
  const zeroEvm = '0x0000000000000000000000000000000000000000';
  check(
    network.payTo !== zeroEvm && network.payTo !== '0.0.0',
    `${id} does not pay to the zero address`,
  );

  if (network.kind === 'evm') {
    check(isEvmAddress(network.payTo), `${id} payTo is a well-formed EVM address`);
    check(isEvmAddress(network.asset), `${id} asset is a well-formed EVM address`);
    check(
      network.unitsPerUsdMinor === 1n,
      `${id} scales 1:1 from USD minor, as a six-decimal stablecoin does`,
    );
  } else {
    check(isEntityId(network.payTo), `${id} payTo is a Hedera entity id`);
    check(isEntityId(network.feePayer), `${id} declares a fee payer`);
    check(
      network.unitsPerUsdMinor > 1n,
      `${id} converts USD minor into tinybars rather than assuming 1:1`,
    );
  }
}

const fallback = vars.DEFAULT_NETWORK;
check(
  Boolean(fallback) && parsed.has(fallback!),
  `the default network (${fallback}) is one of the configured ones`,
);

check(Boolean(vars.FACILITATOR_URL), 'a facilitator is configured; without one paid routes close');

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
