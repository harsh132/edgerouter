/**
 * One wallet's tab: a prepaid balance, and every voucher spent against it.
 *
 * The first state this gate has ever kept, so it is worth saying exactly why it
 * is allowed to exist. The gate refused state because state meant credit —
 * serving somebody before their money moved, which needs an identity worth
 * checking, which needs a signup. A tab runs the other way round. The money
 * moves first, in an ordinary settled x402 payment, and the gate owes the payer
 * rather than the reverse. Nobody is trusted who has not already paid; the
 * payer trusts the gate with one top-up, and no more than one.
 *
 * One object per payer per network, named `network:address`. That is the
 * coordination atom: every voucher against one tab has to see the same balance,
 * and nothing about one wallet's tab ever needs to see another's.
 *
 * ## Money is stored as text
 *
 * Balances are decimal strings and arithmetic happens in `BigInt`. SQLite
 * integers are 64-bit and would hold these amounts, but the binding's parameter
 * types do not promise bigint round-trips, and a balance that silently became a
 * float is the one bug this file cannot afford.
 *
 * ## A voucher's life
 *
 *   reserve   the call's ceiling leaves the balance, and the nonce is recorded
 *   settle    what the call cost stays spent; the rest of the ceiling returns
 *
 * Both are single-statement transitions with no `await` between the read and
 * the writes, so they commit atomically — two calls racing the same nonce see
 * one reservation, and two calls racing one balance cannot both spend it.
 *
 * A reservation that is never settled keeps its full ceiling. That is what a
 * stream cut off before its usage arrived looks like, and the voucher already
 * said the payer would accept that charge without being told the real one.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export type Reserved =
  | { ok: true; balanceMinor: string }
  | { ok: false; reason: 'nonce_used' | 'insufficient'; balanceMinor: string };

export type Settled = { chargedMinor: string; balanceMinor: string };

export type VoucherState =
  | { status: 'unknown' }
  | { status: 'reserved'; reservedMinor: string; node: string }
  | { status: 'charged'; chargedMinor: string; node: string };

type VoucherRow = {
  nonce: string;
  node: string;
  reserved_minor: string;
  charged_minor: string | null;
};

export class Tab extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS balance (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          minor TEXT NOT NULL
        );
        INSERT OR IGNORE INTO balance (id, minor) VALUES (1, '0');
        CREATE TABLE IF NOT EXISTS topups (
          ref TEXT PRIMARY KEY,
          minor TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vouchers (
          nonce TEXT PRIMARY KEY,
          node TEXT NOT NULL,
          reserved_minor TEXT NOT NULL,
          charged_minor TEXT,
          at INTEGER NOT NULL
        );
      `);
    });
  }

  private read(): bigint {
    return BigInt(this.ctx.storage.sql.exec<{ minor: string }>('SELECT minor FROM balance WHERE id = 1').one().minor);
  }

  private write(minor: bigint): void {
    this.ctx.storage.sql.exec('UPDATE balance SET minor = ? WHERE id = 1', minor.toString());
  }

  async balance(): Promise<string> {
    return this.read().toString();
  }

  /**
   * Adds a settled top-up.
   *
   * Keyed by the payment's own nonce, so a top-up that is retried — the client
   * timed out after settlement and asked again — credits once. The chain would
   * refuse to settle the same authorization twice; this refuses to count it
   * twice, which is the same rule applied to the ledger.
   */
  async credit(ref: string, minor: string): Promise<{ credited: boolean; balanceMinor: string }> {
    const seen = this.ctx.storage.sql.exec('SELECT ref FROM topups WHERE ref = ?', ref).toArray();
    if (seen.length > 0) return { credited: false, balanceMinor: this.read().toString() };

    const next = this.read() + BigInt(minor);
    this.ctx.storage.sql.exec('INSERT INTO topups (ref, minor, at) VALUES (?, ?, ?)', ref, minor, Date.now());
    this.write(next);
    return { credited: true, balanceMinor: next.toString() };
  }

  async reserve(nonce: string, minor: string, node: string): Promise<Reserved> {
    const balance = this.read();

    const used = this.ctx.storage.sql.exec('SELECT nonce FROM vouchers WHERE nonce = ?', nonce).toArray();
    if (used.length > 0) return { ok: false, reason: 'nonce_used', balanceMinor: balance.toString() };

    const amount = BigInt(minor);
    if (balance < amount) return { ok: false, reason: 'insufficient', balanceMinor: balance.toString() };

    this.ctx.storage.sql.exec(
      'INSERT INTO vouchers (nonce, node, reserved_minor, charged_minor, at) VALUES (?, ?, ?, NULL, ?)',
      nonce,
      node,
      minor,
      Date.now(),
    );
    this.write(balance - amount);
    return { ok: true, balanceMinor: (balance - amount).toString() };
  }

  /**
   * Turns a reservation into a charge.
   *
   * Idempotent: settling a voucher that is already charged returns the charge
   * it already has, and never moves money a second time. The charge is capped
   * at what was reserved, so no path through here takes more than the voucher
   * allowed.
   */
  async settle(nonce: string, chargedMinor: string): Promise<Settled | null> {
    const row = this.ctx.storage.sql
      .exec<VoucherRow>('SELECT nonce, node, reserved_minor, charged_minor FROM vouchers WHERE nonce = ?', nonce)
      .toArray()[0];
    if (!row) return null;
    if (row.charged_minor !== null) {
      return { chargedMinor: row.charged_minor, balanceMinor: this.read().toString() };
    }

    const reserved = BigInt(row.reserved_minor);
    const asked = BigInt(chargedMinor);
    const charged = asked > reserved ? reserved : asked;
    const next = this.read() + (reserved - charged);

    this.ctx.storage.sql.exec('UPDATE vouchers SET charged_minor = ? WHERE nonce = ?', charged.toString(), nonce);
    this.write(next);
    return { chargedMinor: charged.toString(), balanceMinor: next.toString() };
  }

  /** What became of one voucher. Public: a nonce is random and names nothing. */
  async voucher(nonce: string): Promise<VoucherState> {
    const row = this.ctx.storage.sql
      .exec<VoucherRow>('SELECT nonce, node, reserved_minor, charged_minor FROM vouchers WHERE nonce = ?', nonce)
      .toArray()[0];
    if (!row) return { status: 'unknown' };
    return row.charged_minor === null
      ? { status: 'reserved', reservedMinor: row.reserved_minor, node: row.node }
      : { status: 'charged', chargedMinor: row.charged_minor, node: row.node };
  }
}
