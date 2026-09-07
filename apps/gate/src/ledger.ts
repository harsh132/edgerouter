/**
 * Unsettled debt, and who is not getting served again until it clears.
 *
 * The gate verifies a payment, calls upstream, then settles. That ordering is
 * right for the user — settling first and then failing upstream would charge
 * for something never delivered, and refunding needs a path that can itself
 * fail. But it leaves the operator exposed: a payer can let verification
 * succeed, take the answer, and let settlement fail. Once is a rounding error.
 * Automated, it is a way to spend someone else's upstream budget indefinitely.
 *
 * So the loss is bounded rather than accepted. Every settlement failure is
 * recorded against both the payer and the capability that authorised it, and a
 * caller carrying debt is refused before the upstream call rather than after.
 *
 * This is not the real fix. The real fix is a funded balance — Circle Gateway
 * nanopayments debit money already sitting in a Gateway balance, so settlement
 * cannot fail the way an on-chain transfer can. This bounds the exposure until
 * that exists, and stays useful afterwards for the outages that remain.
 *
 * Two keys per incident, because they are evaded differently:
 *
 *   payer      — an address. Cheap to rotate, so this alone gives an attacker
 *                one free call per fresh wallet.
 *   capability — a node id, which only the root key holder can mint. Expensive
 *                to rotate, so this is the one that actually bites.
 */

export type Debt = {
  /** Consecutive settlement failures. */
  failures: number;
  /** Total value served but never settled, smallest unit. */
  owedMinor: string;
  /** Epoch ms of the most recent failure. */
  lastAt: number;
};

export type LedgerStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type LedgerPolicy = {
  /** Refuse once this many failures have accumulated. */
  maxFailures: number;
  /** Refuse once this much is owed, regardless of the count. */
  maxOwedMinor: bigint;
  /** How long a record survives. Debt is not a life sentence. */
  ttlSeconds: number;
};

export const DEFAULT_POLICY: LedgerPolicy = {
  // One failure is an outage; three in a row is a pattern.
  maxFailures: 3,
  // Roughly ten of the cheapest calls. Small enough to cap the bleed, large
  // enough that a genuine facilitator wobble does not lock a user out.
  maxOwedMinor: 10_000n,
  // A week. Long enough to deter, short enough that a payer who had one bad
  // day is not banned for good — and nobody has to run a support queue.
  ttlSeconds: 7 * 24 * 60 * 60,
};

const keyFor = (kind: 'payer' | 'cap', id: string): string =>
  `debt:${kind}:${id.toLowerCase()}`;

const read = async (store: LedgerStore, key: string): Promise<Debt | null> => {
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Debt>;
    if (typeof parsed.failures !== 'number' || typeof parsed.owedMinor !== 'string') return null;
    return {
      failures: parsed.failures,
      owedMinor: parsed.owedMinor,
      lastAt: typeof parsed.lastAt === 'number' ? parsed.lastAt : 0,
    };
  } catch {
    // A corrupt record is treated as no record. Refusing service because our
    // own bookkeeping is unreadable punishes the user for our bug.
    return null;
  }
};

export type Standing =
  | { ok: true }
  | { ok: false; kind: 'payer' | 'cap'; debt: Debt };

/**
 * Whether this caller is in good standing, checked before anything is spent.
 *
 * Both identifiers are checked. A payer rotating wallets still trips the
 * capability record, and a fresh capability still trips the payer record —
 * evading both means minting a new capability *and* funding a new wallet, which
 * is the point.
 */
export const standing = async (
  store: LedgerStore,
  policy: LedgerPolicy,
  ids: { payer: string | null; capability: string },
): Promise<Standing> => {
  const checks: [('payer' | 'cap'), string][] = [['cap', ids.capability]];
  if (ids.payer) checks.push(['payer', ids.payer]);

  for (const [kind, id] of checks) {
    const debt = await read(store, keyFor(kind, id));
    if (!debt) continue;
    if (debt.failures >= policy.maxFailures || BigInt(debt.owedMinor) >= policy.maxOwedMinor) {
      return { ok: false, kind, debt };
    }
  }
  return { ok: true };
};

/** Records a served-but-unsettled call against both identifiers. */
export const recordFailure = async (
  store: LedgerStore,
  policy: LedgerPolicy,
  ids: { payer: string | null; capability: string },
  amountMinor: bigint,
): Promise<void> => {
  const now = Date.now();
  const targets: [('payer' | 'cap'), string][] = [['cap', ids.capability]];
  if (ids.payer) targets.push(['payer', ids.payer]);

  for (const [kind, id] of targets) {
    const key = keyFor(kind, id);
    const existing = (await read(store, key)) ?? { failures: 0, owedMinor: '0', lastAt: 0 };
    const updated: Debt = {
      failures: existing.failures + 1,
      owedMinor: (BigInt(existing.owedMinor) + amountMinor).toString(),
      lastAt: now,
    };
    await store.put(key, JSON.stringify(updated), { expirationTtl: policy.ttlSeconds });
  }
};

/**
 * Clears the failure streak after a settlement succeeds — but not the debt.
 *
 * A later payment does not retroactively pay for an earlier call that was never
 * settled, so `owedMinor` stays. Resetting the streak is what stops a single
 * facilitator outage from compounding into a ban for someone who is otherwise
 * paying normally.
 */
export const recordSuccess = async (
  store: LedgerStore,
  policy: LedgerPolicy,
  ids: { payer: string | null; capability: string },
): Promise<void> => {
  const targets: [('payer' | 'cap'), string][] = [['cap', ids.capability]];
  if (ids.payer) targets.push(['payer', ids.payer]);

  for (const [kind, id] of targets) {
    const key = keyFor(kind, id);
    const existing = await read(store, key);
    if (!existing || existing.failures === 0) continue;
    await store.put(
      key,
      JSON.stringify({ ...existing, failures: 0 } satisfies Debt),
      { expirationTtl: policy.ttlSeconds },
    );
  }
};

/** The payer address inside an EIP-3009 authorization, if it is shaped as expected. */
export const payerOf = (payload: Record<string, unknown>): string | null => {
  const auth = payload.authorization;
  if (!auth || typeof auth !== 'object') return null;
  const from = (auth as Record<string, unknown>).from;
  return typeof from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : null;
};
