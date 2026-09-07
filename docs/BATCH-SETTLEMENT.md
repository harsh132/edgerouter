# Batch settlement — the fix for serve-first credit risk

## The problem it solves

The gate verifies a payment, calls upstream, then settles. That ordering is
right for the user: settling first and then failing upstream would charge for
something never delivered, and refunding needs a path that can itself fail.

But it leaves the operator extending credit to an anonymous party. A caller can
let verification succeed, take the answer, and let settlement fail. Once is a
rounding error; automated, it spends someone else's upstream budget
indefinitely.

An unsettled-debt ledger does **not** fix this. Both identifiers a gate can key
on — the payer address and the capability node — cost one signature to rotate,
so a determined caller simply arrives as somebody new. Reputation, rate limits
and blocklists all assume identity is expensive. Here it is free. The ledger in
`apps/gate/src/ledger.ts` is retained as **telemetry** — the unsettled rate is
how a facilitator problem gets noticed — and is deliberately not described as a
control.

## How the scheme works

`scheme: "batch-settlement"`, specified at
<https://docs.x402.org/schemes/batch-settlement.md>.

1. The client deposits ERC-20 into an **on-chain escrow contract** once, via
   EIP-3009 or Permit2. This opens a channel with a pre-funded balance.
2. For each request the client signs a **cumulative voucher**: the total
   claimable from that channel to date, not the amount of this one call.
3. The server verifies the voucher's signature and serves immediately.
4. The server later claims many vouchers in a single on-chain transaction.
5. Idle channels can be cooperatively refunded once outstanding vouchers are
   claimed.

## Why it closes the hole

Funds are locked on chain **before any service is rendered**, and the payer
cannot withdraw them unilaterally. Sybil identities stop helping: a fresh
address must fund a fresh escrow first, so a free call costs real money to
obtain rather than costing a signature.

Two further properties fall out:

- **Cumulative vouchers are self-healing.** Only the latest voucher matters, so
  a dropped or lost one costs nothing and a single claim settles every prior
  call.
- **Sub-cent pricing becomes economic.** One transaction amortises gas across
  thousands of requests, which per-request settlement never can.

## What it costs us

**A liveness requirement.** The payer's withdrawal is time-delayed by
`withdrawDelay`, and the server must claim before that finalises. So the gate
needs a periodic claim job — a Cloudflare Cron Trigger plus somewhere to hold
unclaimed vouchers. That is state, and real state rather than the
lose-it-without-harm kind the debt ledger is.

**A deposit step.** The user funds an escrow before the first call. Smaller than
a signup, and it is how every metered API works, but it is no longer "connect a
wallet and go" on the very first request.

**It may also let pricing become usage-based.** Flat-per-call exists in
`apps/gate/src/pricing.ts` because x402 quotes *before* the work happens and
token counts are known *after*. Against a pre-funded channel the constraint
weakens: a cumulative voucher can reflect actual usage. Worth revisiting once
the channel exists, and deliberately not before — a wrong usage meter is worse
than a blunt flat one.

## Status: planned, and not currently reachable

Verified live on 2026-09-07 with `bun apps/gate/facilitator-check.ts`:

    https://api.testnet.blocky402.com/supported
      exact  eip155:80002
      exact  solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
      exact  hedera:testnet   feePayer 0.0.7162784

    https://api.blocky402.com/supported
      exact  hedera:mainnet   feePayer 0.0.10571514

**`batch-settlement` is offered on no network by either endpoint. Only
`exact`.** Hedera's own documentation agrees: *"settlement is per-request and
discrete. x402 is not built for streaming payments or multi-hop routing."*

So escrow remains the correct fix for the credit-risk problem and is *not*
available through the facilitator Hedera's prize track requires. Three options,
in order of cost:

1. **Accept the exposure for now.** Per-call prices are ~$0.001, so a single
   abuse costs a tenth of a cent. It is only dangerous automated, and the
   telemetry ledger will show it happening.
2. **Find a facilitator that settles `batch-settlement`.** Several exist in the
   x402 directory; none of them is Blocky402, so this trades the Hedera track
   for the economics.
3. **Run our own facilitator.** Hedera documents this path. Most work, most
   control, and the only route that gets escrow *and* the Hedera track.

`facilitator-check.ts` reports whether batch settlement has appeared, so this
document does not have to be re-researched by hand.

## The check that found this

The same script compares configured networks against the facilitator's
capabilities, and caught a live mismatch on its first run: the gate defaulted to
Base Sepolia, which Blocky402 does not settle. A gate can quote a network
perfectly and still be unsettleable — that failure is invisible until a real
payment arrives, by which point a user has signed something nobody can settle.
