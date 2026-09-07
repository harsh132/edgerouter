# edgerouter

**Agents delegate to agents. Money does not.**

Every x402 router answers how *an* agent pays for something. None answer the
next question: when that agent spawns five sub-agents, how much may each spend,
and what stops the tree spending more than the human put in?

edgerouter is two things that fit together — an inference gate you pay for with
a wallet instead of an API key, and a budget layer that lets one agent fund
another without handing over the wallet.

```bash
bun run wallet address     # an address. That is the entire setup.
```

## What works today

Every line here has been run against a live network, not designed.

| | |
|---|---|
| Paid inference, Hedera testnet | settling, generated wallet, no signup |
| Paid inference, Base Sepolia | settling, gasless for the payer |
| Delegation | sub-agent spends without a key, stopped by its budget |
| DSH plugin | installs into DeepSeek Harness, streams tokens |

## No signup, and why that is a design decision rather than a slogan

The gate **settles before it serves**. Nothing is spent on a caller's behalf
until their money has actually moved.

That ordering is load-bearing. Serving first means extending credit; credit
needs an identity to extend it to; an identity is only worth checking if it
cannot be minted for free; and the only unmintable identity here would be a
token we issue — which is a signup. Settling first removes the whole chain, and
costs nothing, because settlement was always inside the critical path anyway.

So there is no account, no key to be issued, and nothing to breach. A capability
token may still be presented, but it only ever *narrows* what a request may do.

## No key to type, either

Asking a user for an account id and a private key is developer UX wearing a
product's clothes. The plugin generates the key and shows an address instead.

On Hedera that works because of auto account creation: an ECDSA public key
yields an EVM address, and the first transfer to it *creates the account*.
Nothing to register, no fee to pay before you can receive. On EVM chains the
address is already an account.

The key lives in `~/.edgerouter/`, unencrypted, and the README for the plugin
says so plainly rather than implying otherwise — encryption needs a key, and one
sitting beside the ciphertext protects nothing. It is a hot wallet holding what
you chose to put in it, and `sweep` exists because a wallet you cannot leave is
a hostage.

## Delegation: the part that could not be stateless

A capability says what *one request* may do — a per-call ceiling, an expiry, a
host list — and the gate checks that with no memory at all, by recomputing a
signature chain.

But "this sub-agent may spend one hbar in total" is a running total, and a
running total is state. So the budget lives in the one process that already had
to be stateful: the one holding the key.

```
caveats   stateless, at the gate    per-call ceiling, expiry, hosts, depth
tree      stateful, in the authority cumulative budget, funding, revocation
```

A sub-agent holding a capability never sees a key. It asks the authority to
sign one payment; the authority charges that payment to the sub-agent's node;
an empty node buys nothing. The delegated signer satisfies the same interface as
a local one, so the paying client is not a different code path — it is the same
client pointed at an allowance.

**Attenuation only narrows**, and not because a rule forbids widening. Macaroon
semantics: appending a caveat is one HMAC, removing one needs a signature that
was destroyed when it was added. Widening is unreachable, not prohibited.

**Revocation is emptying, not listing.** Sweep a node and its subtree; a valid
token over an empty balance already grants nothing, so there is no revocation
list and nothing is eventually-consistent.

Proven end to end against the deployed gate, with real money:

```
call 1   paid 0.01234 ℏ, 0.01851 ℏ left
call 2   paid 0.01234 ℏ, 0.00617 ℏ left
call 3   REFUSED — budget_exhausted: holds 617000, this call costs 1234000
```

The refusal comes from the side holding the money. A cap a sub-agent enforces on
itself is not a cap.

### What the tree is, precisely

Nodes are accounting entries in the authority, not one wallet each. One real
wallet sits underneath, and the tree decides who may spend how much of it. The
guarantee is therefore as strong as the authority process — which is the right
place for it, since that process holds the key regardless, and it is what makes
delegation instant and free rather than a transaction per sub-agent.

The on-chain bound is the wallet itself: it can only ever spend what was put in
it, whatever happens above.

## Layout

```
packages/core   attenuation algebra + funding rules      no dependencies
packages/sdk    x402 client, wallets, budget authority
packages/dsh    DeepSeek Harness provider plugin
apps/gate       the x402 gate — a stateless Cloudflare Worker
docs/           product thesis, build plan, verified findings
```

## The gate

An OpenAI-compatible endpoint behind x402. Point any existing client at it:

```
price the request  →  402 or accept payment  →  verify  →  settle
→  proxy upstream  →  stream the answer back
```

Stateless: no database, no session, no account. Two networks, each settled by
whichever facilitator actually settles it — Hedera through Blocky402, Base
Sepolia through x402.org — because no facilitator covers everything and a single
global one caps the gate at that facilitator's own coverage.

Answers stream. The gate hands its upstream body through unread rather than
collecting it, and the settlement receipt rides in a header sent ahead of the
first byte — so a streamed answer is paid for as completely as a buffered one,
and the proof arrives before the text.

## Checks

```bash
bun run check          # every offline check — 364 of them
bun run typecheck
bun run dev            # wrangler dev

bun run wallet         # address | balance | watch | sweep | export
bun run authority      # a budget authority on loopback
```

Anything that spends is separate and run by hand, because it spends:

```bash
bun run pay-check              # one Hedera payment
bun run evm-pay-check          # one EIP-3009 payment
bun run fund-check             # proves auto account creation
bun run delegate-live-check    # a keyless sub-agent, to its limit
bun run live-check             # the DSH adapter, end to end
```

`packages/core` has no dependencies on purpose. The claim the whole product
rests on — that a delegated budget can only narrow — is checked against random
trees and random caveat orders, with no network, no chain, and no API key.

## Status

The full loop works and has been paid for on two chains. What is not done:
mainnet (testnets only, deliberately), an EVM sweep path exercised end to end,
and a way to drive delegation from the Desktop UI rather than the CLI.

Details in [docs/PROJECTS.md](docs/PROJECTS.md).
