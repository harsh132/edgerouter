# edgerouter — the build

Downstream of `PRODUCT.md`, which fixes the thesis. This says what gets built,
which sponsors it reaches, and what gets cut first.

Rewritten 2026-09-06 for the stateless architecture. Two earlier versions are in
git history: the first recommended an agent wallet + MCP + policy engine, which
prior-art research killed; the second assumed a stateful server with a
database-backed ledger, which the funded-wallet model replaced.

ETHGlobal takes one project across many tracks, so this is one build.

## Layout

```
apps/web          part 1 — Cloudflare Worker: landing, docs, x402 gate,
                  model API, stateless tree viewer
apps/chat         part 1b — app.edgerouter.io, pure client: wallet connect,
                  chat, live budget tree. No server state
packages/core     attenuation algebra + capability tokens   ← pure, no deps
packages/sdk      part 2 — session, wallets, funding, x402 client
packages/dsh      DeepSeek Harness plugin adapter
packages/mcp      MCP adapter (Claude Code, Cursor, any MCP host)
```

Part 1 is a Cloudflare Worker, which the stateless design suits exactly: no
database to provision, no session store, and the x402 gate is pure computation
over a request. Workers also put verification physically near the caller, which
matters when a paid call is in the critical path of an agent's turn. Nothing
here needs Durable Objects — the moment it does, the design has drifted back
towards state.

`packages/core` stays dependency-free so the rules are testable without an API
key, a chain, or a network — the pattern `delegation-check.ts` and
`browser-check.ts` used in wallet2.

## Parts

| # | Part | Where | What | Risk |
|---|---|---|---|---|
| 1 | **Token algebra** | core | mint, attenuate, verify. Caveats only narrow | **high** — the thesis |
| 2 | **Funding rules** | core | fund child, sweep child, depth bound | medium |
| 3 | **x402 gate** | web | verify token → verify payment → proxy | low |
| 4 | **Model API** | web | OpenAI-compatible, proxies OpenRouter upstream | low |
| 5 | **Landing + docs** | web | first thing a judge sees | medium |
| 6 | **Tree viewer** | web | stateless; root name in, tree out | medium |
| 6b | **Chat app** | chat | app.edgerouter.io — fan-out task, live tree beside it | medium — **the demo** |
| 6c | **Subname minting** | chat | `you.edgerouter.eth` on sign-in | **high** — ABI unknown |
| 7 | **Wallet layer** | sdk | Privy embedded, HD derivation per node | medium |
| 8 | **x402 client** | sdk | 402 → pay → retry, host allowlist | medium |
| 9 | **Delegation API** | sdk | spawn child, fund, issue token, revoke | low |
| 10 | **Approval flow** | sdk | quorum path and Ledger path | medium |
| 11 | **Indexer** | — | Graph subgraph over the address tree | low |
| 12 | **ENS registry** | sdk | subname per node, Enhanced Access Control | **high** — ABI unknown |
| 13 | **DSH plugin** | dsh | thin adapter over the SDK | low |
| 14 | **MCP adapter** | mcp | same SDK, different host | low |
| 15 | **Circuit breaker** | — | CRE workflow: reconcile balances, sweep on divergence | low |
| 16 | **Hedera service** | — | x402-gated service via Blocky402 | high — a second product |

**Minimum demoable core: 1, 2, 3, 7, 8, 9, 6, 6b.** An agent delegates a narrower
budget to a sub-agent, both pay real x402 services, a human watches the tree
drain. That is the whole pitch. Everything else is track-serving addition on top
of something that already works.

## Sponsor mapping

Every entry is forced by the design rather than bolted on — the test a judge
applies.

| Sponsor | Track | $ | Why it is load-bearing |
|---|---|---|---|
| Hedera | AI & Agentic Payments | 6,000 | host the gate as the x402 service via **Blocky402**; their extra-points list names pay-per-call inference metering and multi-agent A2A |
| The Graph | AI Tooling, from scratch | 5,000 | a tree of addresses makes an indexer the *only* way to reconstruct spend |
| ENS | Best Use of ENSv2 | 4,500 | hierarchical registry + Enhanced Access Control mirrors the token tree on chain — not the flat "subname = identity" five projects already shipped |
| Ledger | AI Agents × Ledger | 3,500 | root funding by device press; Key Ring for VPS/CI-hosted agent secrets |
| Arc | Testnet → mainnet | 3,500 | USDC settlement. Mainnet by **Sept 30** |
| Privy | Best B2B Financial Product | 2,500 | HD wallets per node, key quorums for material actions |
| Chainlink | Confidential Workflow | 2,000 | reconcile declared tree against real balances, sweep on divergence. **CLI simulation is accepted proof** |
| Arc | Agentic Economy | 1,667 | autonomous USDC spend, Agent Stack |
| Bazantic | Agentify a New API | 1,000 | the gate becomes a Bazantic service + Recipe |

**~$24k without Hedera. ~$30k with.**

Distribution, no prize attached: the **DSH plugin**. Not a sponsor — it is the
user path.

## Order of work

1. **`packages/core` + property tests.** Token attenuation and funding rules,
   with random trees and random spend orders asserting the root total is never
   exceeded. No dependencies, so this de-risks the thesis before any API key
   exists. **Do this first.**
2. **Spike ENSv2 subname minting.** The `register` ABI is unknown; resolution is
   verified. If minting fails the product survives — the tree lives in wallets
   and ENS degrades to resolution — but the ENS track drops $4,500 → $500 and
   the on-chain permission claim goes away.
3. **Spike Ledger `wallet-cli ring`.** Gates the best-fitting track; nobody here
   has touched it.
4. SDK: Privy wallets, HD derivation, funding, token issuance.
5. Web: x402 gate + model API.
6. SDK: x402 client, end-to-end paid call.
7. Tree viewer, then the chat app — fan-out task and live tree.
8. DSH plugin, MCP adapter.
9. Landing + docs.
10. Chainlink circuit breaker — simulation is enough.
11. Hedera + Blocky402, only if the calendar allows.

## Cut order

From the bottom:

1. **Hedera** — largest purse, but a second hosted service is a second thing to
   keep alive during a demo.
2. **Circuit breaker** — good architecture, smallest purse, and balances already
   enforce the fast path.
3. **Bazantic** — a wrapper over something that must already work.
4. **Arc mainnet push** — testnet demonstrates the same thing.

Never cut: token attenuation, funded wallets, and the chat app's live tree.
Those are the project. A chat app without the tree is The42 with a new logo.

## Alternatives considered

- **Agent wallet + MCP + policy + hardware** — built by Sentinel (won ENS),
  ENShell, Polyledger, SpendMate. Dropped.
- **x402 LLM router over OpenRouter** — built by Router402 (HackMoney finalist),
  ClawRouter, The42, `ekailabs/x402-openrouter`, and a public tutorial.
  OpenRouter itself now settles in x402. Kept only as plumbing, never as the
  pitch.
- **Privacy-preserving USDC invoicing** — coherent, ~$17k, reaches neither
  Ledger nor Hedera nor Chainlink.
- **Agent-managed Aqua position (1inch)** — $5,000, highest technical risk.
  Only if someone already knows SwapVM.

## Standalone smalls

One person, low coupling, compatible with the main build.

- **Chainlink liquidation challenge** ($500) — `join()` on Sepolia at
  `0x59d5B29FbA5ca865a171076BE94EbEeC5BCA1E04` before the deadline. Cannot be
  updated afterwards.
- **Hedera Harness contribution** ($1,000 × 2) — an accepted PR. Cheapest money
  on the board if a real gap turns up.
- **Uniswap** ($3,000) — needs only `FEEDBACK.md` and the form beyond a build.

## Deliberately skipped

- **World** — both tracks are proof-of-humanity, contradicting an unlinkability
  thesis.
- **Hedera Tokenization** ($6,000) — Asset Tokenization Studio, zero overlap.
- **1inch / Uniswap as primary** — DeFi surface unrelated to agent budgets.

## The framing trap

Part 1 includes an x402 model API — the thing Router402, ClawRouter, The42 and a
public tutorial already built. That is fine: Hedera's track requires hosting an
x402-gated service, and it makes the demo self-contained.

But it stays **plumbing, not pitch**. If the landing page says "pay-per-call LLM
access, no signup," this is the eighth of those. If it says "budgets that survive
an agent spawning agents," it is the first. Same code, different framing, and the
framing is what gets judged.

## Still unknown

The submission deadline. The event page has returned HTTP 500 on every attempt.
Arc's "mainnet by September 30" is a track requirement, not the deadline. This
decides how much of the list above is reachable.
