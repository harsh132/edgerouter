# edgerouter

**Agents delegate to agents. Money does not.**

Every x402 router answers one question: how does *an* agent pay for something.
None answer the next one — when that agent spawns five sub-agents, how much may
each spend, and what stops the tree spending more than the human put in?

An edge router sits at the boundary of a network and decides what may pass.
This one sits at the boundary of an agent tree and decides how much may be
spent — routing budget outward rather than packets. It runs on Cloudflare
Workers, which is where the name comes from and what the stateless design is
shaped for.

`edgerouter.eth` · `edgerouter.io`

## The problem

An agent gets $50 and a task. It decomposes the task and spawns five
researchers. Each calls an LLM. Two spawn their own sub-agents. Forty API calls
happen somewhere in that tree.

The only workable answers today are both bad:

- **One shared key.** Every node spends from the same pot with no isolation. One
  runaway loop, or one prompt-injected node, drains it.
- **No delegation.** Refuse to let agents spawn agents — which is not how any
  real agent framework works, including the one this was written in.

What is missing is *attenuation*: handing a child strictly less than you hold,
with the ceiling enforced where neither parent nor child can reach it.

## The mechanism

Two primitives, and between them the enforcement is almost entirely structural
rather than procedural.

### Budget is balance

Each node in the tree is an HD-derived wallet holding its actual allocation.
Delegating is a funding transfer, not a policy row.

| Rule | How it holds |
|---|---|
| a child's budget is a subset of its parent's | arithmetic — you can only fund from what you hold |
| a child spending spends its parent too | arithmetic — the money already left the parent |
| no node can raise its own limit | arithmetic — it cannot mint USDC |

Three of the original six invariants stop being rules anyone enforces and become
balances. That is strictly stronger than a policy engine, because there is no
check left to bypass.

### Capability tokens that only narrow

A parent issues its child a token carrying the node id and ceiling, signed. A
child may add caveats, never remove them — macaroon semantics. Verification is a
signature chain and nothing else, so it needs no server state.

The remaining rules ride on the token:

- **A parent may revoke a child; a child may never revoke a parent.**
- **Revocation is transitive** — revoking a node kills its whole subtree.
- **Depth is bounded.** A chain that grows forever is a spend amplifier.

**Revocation is sweeping, not listing.** Statelessness means no revocation list,
and none is needed: revoking a child means emptying its wallet. A valid token
over an empty balance is harmless. That is better than a revocation list —
immediate, and nothing has to remember it. Pair with short token expiry.

## Architecture

Two parts. The service is stateless and the user never visits it.

### Part 1 — the service

```
request → verify capability token   (crypto, no lookup)
        → verify x402 payment       (facilitator)
        → proxy upstream
        → return
```

No accounts, no database, no sessions, no onboarding. It also serves a landing
page, docs, and a **stateless tree viewer** — give it a root name, it renders the
tree from chain state and The Graph. Nothing is stored.

### Part 1b — app.edgerouter.io

A chat client, and a **pure client**: wallet connect is Privy in the browser,
chat history is `localStorage`, inference is the page calling the gate with a
capability token, and the tree is read from chain plus The Graph. Nothing on the
server remembers anything, so the statelessness above is untouched.

It exists because a judge can use it in thirty seconds, which no plugin install
can match.

**It must fan out, or it is not this product.** A chatbot that answers one
question never delegates, so nothing attenuates and the thesis is invisible — at
which point it is The42 with a different logo. The app takes a task, spawns
sub-agents with their own funded budgets, and renders the tree draining beside
the conversation.

The demo moment is a sub-agent capped low, hitting its ceiling on camera: that
node stops, its siblings continue, the parent is untouched. Anyone can show an
agent spending. Showing one stop is the part that says the design was thought
about.

Users without an ENS name get a subname — sign in, receive
`you.edgerouter.eth`, and the tree hangs off it. No name to buy, and the tree is
legible from the first second.

### Part 2 — the SDK

Wrapped as a DeepSeek Harness plugin, and as an MCP adapter for other hosts.
Holds the user's session, creates and funds child wallets, mints and attenuates
tokens, and pays 402 challenges. Holds no authority it could widen — a token it
cannot un-caveat, over a balance it cannot inflate.

## Prior art

Researched 2026-09-06 across the ETHGlobal showcase and GitHub. This exists so
the submission states its differentiation rather than hoping a judge does not
know the field. **It is a crowded field.**

| Project | What it did |
|---|---|
| **Router402** | OpenRouter-compatible gateway, USDC per call via x402. *HackMoney 2026 finalist* |
| **ClawRouter** | Agent-native LLM router; wallet signature is the account |
| **The42** | Multi-LLM gateway, per-request micropayments, streaming payment during inference |
| **0pi** | Wrap any API in x402; providers paid at their ENS address |
| **MCPay.fun** | Pay-per-use API access, no keys or OAuth |
| **Sentinel MCP Wallet** | MCP wallet + policy engine, policy hash in ENS text records. *Won the ENS prize* |
| **ENShell** | Agent-intent firewall, escalation to Ledger Live with ERC-7730 clear signing |
| **Polyledger** | Agents propose, Ledger displays, Chainlink CRE validates before signing |
| **SpendMate** | Agents that spend with rules and limits |
| **HumanENS / AgentRadar / AgentArena / ACN / Elara** | Agent identity as an ENS subname, five separate times |
| **AgentH** | A main agent delegating *tasks* to sub-agents |

Note what the last row does not say. AgentH delegates work. **Nothing here
delegates money with attenuation.** `x402-openrouter` has a public tutorial, and
OpenRouter itself now settles in x402 — the router layer is not merely built, it
is commoditised.

**So do not build a router.** Sit above them. edgerouter works with Router402,
ClawRouter, or OpenRouter's own endpoint as the thing being paid.

## What is novel

1. **Attenuating delegation.** The mechanism above. This is the product.
2. **Unlinkability.** Every project listed hands the agent one address, so fifty
   paid services see one identity and can correlate. A wallet per node, per
   counterparty, removes that for free — the tree already needs separate
   addresses.
3. **Provenance.** Which prompt, and which URL, caused which payment. Nobody
   records the causal chain, so "why did forty cents go to a domain I have never
   heard of" is unanswerable everywhere else.

The batch-window overspend problem that dominated the earlier design is gone: a
child cannot overspend a balance it does not have. Balance accounting becomes
Circle Gateway's problem, which is where it belongs.

## Users

Two personas. The split resolves a real contradiction between "no web3
knowledge required" and "hardware confirmation."

**The individual developer — not a crypto user.** Runs agents in DeepSeek
Harness or Claude Code. Wants a budget and a bill. Signs in, tops up with a card,
sets a budget, agents spend. No seed phrase, no extension, no chain switching —
USDC is gas on Arc and nanopayments are gasless, so no gas token is ever
surfaced. Material actions go through a Privy key quorum. No hardware.

**The team — has a treasury.** Funds many agents from one pot, on a server or in
CI. The key is Ledger-backed via Key Ring, which is exactly Ledger's stated
"VPS/CI/hosted agents" pattern. Device press for anything material.

Onboarding is frictionless for the human; the *organisational* key is hardware.
Neither claim is a fudge.

## The interface problem nobody has solved

Not login. Making a budget tree legible:

> your research agent spent $3.20 across 40 calls to 6 services, and its two
> sub-agents used $1.10 of that

There is no good interface for this anywhere. It is where the design effort
goes, and what a judge remembers. It is also where ENS earns its place twice: the
tree reads `research.agent.you.eth`, not `0x7f3a…`. Names as **legibility**, not
only as permissions.

## Non-goals

- **Not another LLM router.** Router402, ClawRouter, The42 and OpenRouter itself
  already do this. edgerouter is a layer above whichever one the user points at.
- **Not a stateful service.** No accounts, no database, no dashboard login. If a
  feature needs the server to remember a user, it is the wrong feature.
- **Not a shielded pool.** Unlinkability here comes from fresh addresses, not ZK.
- **Not a general wallet.** No swap screen, no NFT gallery, no portfolio.
- **Not novel onboarding.** Privy onboarding serves two tracks and makes the demo
  watchable. It is table stakes, not the thesis. If the build drifts into "we
  made nice onboarding," the un-built part has been lost.

## Open risks

| Risk | Status |
|---|---|
| ENSv2 **registration** ABI unknown; only resolution is chain-verified | `FINDINGS.md`. Spike minting early — the on-chain tree depends on it |
| Ledger brief says device security must be **central**; optional for persona 1 | Lead the demo with the team persona, or accept Ledger as a secondary fit |
| Funding-as-attenuation uses less of Privy's policy engine | Key quorums for material actions still satisfy "≥1 Privy control" |
| Circle Agent Wallet policy — can the agent mutate it? | Undocumented. Privy's is provably server-side. Check before relying on it |
| Arc + Gateway nanopayments pairing | Marketing lists Arc; nanopayments docs never confirm it |
| Attenuation prior art | Searched, not found. Weaker evidence than the chain probes in `FINDINGS.md` |
| Submission deadline | Unconfirmed. Event page returns HTTP 500 |

## Companion documents

- `FINDINGS.md` — verified facts, each marked chain-verified, DNS-verified, or docs-only
- `MCP-SPEC.md` — tool surface and policy model (predates the stateless design; the tier model survives, the ledger section does not)
- `PROJECTS.md` — the build, sponsor mapping, cut order
