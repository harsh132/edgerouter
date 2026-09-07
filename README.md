# edgerouter

**Agents delegate to agents. Money does not.**

Every x402 router answers how *an* agent pays for something. None answer the
next question: when that agent spawns five sub-agents, how much may each spend,
and what stops the tree spending more than the human put in?

edgerouter is the budget layer above whichever router you already use. A parent
hands a child strictly less than it holds, and neither can widen it.

## How it holds

**Budget is balance.** Each node in the tree is a wallet holding its actual
allocation, so three rules stop being rules and become arithmetic: you can only
fund from what you hold, the money already left the parent, and nobody can mint
currency.

**Capability tokens only narrow.** Macaroon semantics — a holder may append a
caveat, never remove one, because removing it needs a signature that was
destroyed when it was added. Verification is a signature chain, so the service
that checks it needs no database and no memory of who was issued what.

**Revocation is sweeping, not listing.** Empty a node's wallet and its whole
subtree; a valid token over an empty balance is harmless.

## Layout

```
packages/core   attenuation algebra + funding rules   no dependencies
apps/gate       the x402 gate — a stateless Cloudflare Worker
docs/           product thesis, build plan, verified findings, MCP spec
```

## The gate

An OpenAI-compatible endpoint behind x402. Point any existing client at it and
pass a capability where the API key goes:

```
verify capability  →  price the request  →  check the policy
→  402 or accept payment  →  proxy upstream  →  settle
```

Stateless: no database, no session, no account. A capability is a signature
chain recomputed from a key derived per root, and payment is verified by a
facilitator, so nothing needs remembering between requests.

## Checks

```bash
bun run check                     # core property tests + gate logic
bun packages/core/check.ts 42     # any seed; failures print the seed to reproduce
bun run dev                       # wrangler dev on :8787
bun run smoke                     # end-to-end against a running gate
bun run typecheck
```

`packages/core` has no dependencies on purpose. The claim the whole product
rests on — that a delegated budget can only narrow — is checked against random
trees and random caveat orders, with no network, no chain, and no API key.

## Status

Early. `packages/core` and `apps/gate` are done and tested — 34 property
checks, 33 gate checks, 14 end-to-end against a live Worker. Payment settlement
has never run against a real facilitator. Everything else is in
[docs/PROJECTS.md](docs/PROJECTS.md).
