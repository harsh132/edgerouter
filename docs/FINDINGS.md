# Spike results — Privy multi-wallet, ENSv2 on Sepolia

Verified 2026-09-02. Sepolia block 11615734.

Both load-bearing assumptions hold. One is verified on chain; the other is only
verified against documentation, and the difference matters — see the caveats.

## Privy: multiple addresses per login

**Confirmed, documentation only. Nothing here was executed** — that needs an app
ID and an account, which we do not have yet.

- `createWallet({ createAdditional: true })` (React). The flag defaults to
  `false`, so additional wallets are an explicit opt-in rather than something
  that happens by accident.
- Equivalents exist on every SDK: React Native `create({createAdditional})`,
  Swift/Kotlin `createEthereumWallet(allowAdditional:)`, Unity, Flutter.
- Wallets are **HD-derived from one seed**, not independent keys:
  `m/44'/60'/0'/0/i`, zero-indexed.
- Index 0 must exist before a higher index can be created, so there are no gaps.
  Indexes appear stable once assigned.
- No documented hard maximum for dynamically created wallets. Pregeneration is
  capped at 10.
- One recovery method covers every wallet, since they share the seed.

**Why this matters more than it looks:** `m/44'/60'/0'/0/i` is the *same*
derivation the existing wallet already uses for its public address book
(`accountPath(index)` in `wallet2/src/lib/wallet/public-addresses.ts`). The
per-counterparty address model transfers one-to-one — same scheme, same index
semantics — with Privy holding the seed instead of a scrypt vault. The design
carries over; only the custody boundary changes.

**Unverified:** the actual rate at which wallets can be created, any per-app
limit, and whether creating the Nth wallet requires a user interaction. All
three affect whether "a fresh address per counterparty" is usable in a live
demo. Check these first once an app ID exists.

## ENSv2 on Sepolia: verified on chain

Run `bun spikes/ens-v2-check.ts`. Every address below was probed for code, and
resolution was exercised end to end rather than assumed.

### Deployed, with code

| Contract | Address | Size |
|---|---|---|
| UniversalResolverV2 | `0x4a1817d13e9cf196f471725176355c1234b63c70` | 18,495 B |
| PublicResolverV2 | `0xe7b9a25607e02da8145e4eb1836ca539e53f11f7` | 14,433 B |
| ETHRegistry | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | 14,730 B |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | 7,497 B |
| ManagedUniversalResolverProxy | `0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1` | 2,612 B |
| UpgradableUniversalResolverProxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | 2,491 B |

The last one carries the same vanity address as mainnet's Universal Resolver,
which looked like a copy-paste error in the docs table. It is not: it resolves
correctly on Sepolia, so the address really is reused across chains.

### Resolution works

- `vitalik.eth` → `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (correct)
- `nick.eth` → `0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5`
- `ur.integration-tests.eth` → `0x1111111111111111111111111111111111111111`
  (ENS's own integration-test sentinel)

All three returned directly, without a CCIP-Read round trip. The check treats an
`OffchainLookup` revert as a pass, because that is a resolver working as
designed rather than a broken one — but it did not come up here.

**Reading names is safe to build on today.**

### Registration is the open question

The registrar's selectors were read out of its deployed bytecode rather than
guessed, after a first pass guessed wrong and reported working functions as
absent. Named by 4byte:

- `isAvailable(string)` — live and correct: `vitalik` → false, an unregistered
  name → true
- `commit(bytes32)` — commit-reveal is real
- `renew(uint256,uint64)`, `getState(uint256)`
- `GRACE_PERIOD()` = 2,419,200 s (28 days)
- `BENEFICIARY()` = `0x84D3a426D4E12E955d1DF95db0B24fe26afE39D3`

39 selectors are dispatched; only 12 resolve in 4byte. **`register` and the
price quote are among the unnamed** — the ENSv2 ABI is too new to be indexed.
So registration cannot be planned against a known signature yet; the ABI has to
come from the `ensdomains/ens-contracts` repo.

Two known shape changes that will cost time if discovered late:

- Fees move from ETH to **stablecoins**, so registering needs an ERC-20 approval
  before the register call — an extra transaction in any demo flow.
- Token IDs are **mutable** in ENSv2. Never cache them; resolve at transaction
  time.

### Recommendation

Build the ENS track on **resolution**, which is verified working, and treat
**registration** as the stretch. If the pitch needs users to mint a subname
live, get the registrar ABI and run one end-to-end registration on Sepolia
before committing — that is the single riskiest unknown found.

## Scripts

- `spikes/ens-v2-check.ts` — code presence + end-to-end resolution. Exits
  non-zero on failure.
- `spikes/selectors.ts <address> [rpc]` — reads dispatched selectors out of any
  deployed contract and names them via 4byte.
- `spikes/registrar-probe.ts` — live `isAvailable` and constant reads.

## Is ENSv2 on mainnet? No.

Checked on chain at mainnet block 25885697 (`bun spikes/ens-mainnet-check.ts`).

Every ENSv2 address returns **no code** on mainnet: UniversalResolverV2,
PublicResolverV2, ETHRegistry, ETHRegistrar, ManagedUniversalResolverProxy.

The one contract present on both chains is the upgradable Universal Resolver at
the vanity address `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`, whose proxy
bytecode is byte-identical across mainnet and Sepolia (2,491 B). It points at
different implementations:

| Chain | Implementation | Size |
|---|---|---|
| mainnet | `0xED73a03F19e8D849E44a39252d222c6ad5217E1e` | 19,290 B |
| sepolia | `0x6d80F2172CFdEc5730fE683860C33d26fC42e6F1` | 2,612 B |

So the entry point is pre-deployed on mainnet at a fixed address — the migration
path, so the address never has to change — but mainnet still serves a v1-era
implementation. The legacy v1 registry is live at 5,346 B.

Two things from ENS's own announcements, which are claims rather than chain
evidence and are recorded as such:

- **Namechain is cancelled** (February 2026). Ethereum's registration gas fell
  roughly 99%, so the dedicated L2 stopped being worth building. ENSv2 targets
  mainnet directly now. Any plan or pitch mentioning Namechain is stale.
- ENSv2 is described as on track for release during 2026, with no shipped
  mainnet date. Treat it as unscheduled.

**Effect on the hackathon plan: none.** The ENS prize track asks for work
"built on ENSv2 Sepolia", so pre-mainnet is the expected state. It does mean
nothing built here resolves real mainnet `.eth` names during the event — say so
in the demo rather than letting a judge assume otherwise.

## PrivacyBoost on Arc? No — verified by DNS.

PrivacyBoost is a RAILGUN-shaped shielded pool: UTXO notes, deposit / private
transfer / withdraw, self-custodial, ZK **plus TEE** for proving, audited by
OpenZeppelin, built by Sunnyside Labs. Not an ETHOnline sponsor, so it earns no
prize directly — it would be product substance.

The SDK is chain-agnostic. `sdk.forChain({ serverUrl })` needs only that one
field; chainId, shield contract, token registry and **TEE public key** are all
auto-discovered *from the server*. Which means a chain is usable exactly when a
PrivacyBoost server exists for it, and no client-side configuration substitutes
for one.

`bun spikes/pb-servers.ts` — a live server answers `405 encryption required`:

| Server | Chain | Result |
|---|---|---|
| `optimism.privacyboost.io` | OP Mainnet (10) | live |
| `optimism.sepolia.privacyboost.io` | OP Sepolia (11155420) | live |
| `soneium.privacyboost.io` | Soneium | live, **undocumented** |
| `arc.privacyboost.io` | — | DNS does not exist |
| `arc.testnet` / `arc.sepolia` | — | DNS does not exist |
| `base` / `ethereum` / `sepolia` | — | DNS does not exist |

The Soneium result is what makes the negatives meaningful: it confirms the
`<chain>.privacyboost.io` convention, so `arc.*` failing DNS is evidence of
absence rather than a wrong guess. It also shows they ship chains before
documenting them, which is why asking Sunnyside Labs directly is worth one
email — it is the only thing that could change this answer inside two weeks.

**Correction to an earlier note:** OP *Sepolia* is served, not just mainnet. The
whole shielded flow is demoable on testnet with no real funds, and PrivacyBoost
documents Privy as a supported auth method. `PrivacyBoost + Privy on OP Sepolia`
is a working stack today.

## Arc testnet: live, ordinary EVM

`bun spikes/arc-probe.ts`

- RPC `https://rpc.testnet.arc.io` — the only candidate that resolved
- **chainId 5042002** (`0x4cef52`), block 60,016,397, gas limit 30,000,000
- USDC is the gas token, not ETH
- Public mainnet announced for **16 September 2026**, which is what Circle's
  "mainnet deployment by Sept 30" continuity clause is pointing at

Hardhat, Foundry, viem and ethers are supported, so arbitrary contracts deploy.
The "four pre-audited templates" in the deploy tutorial is the scope of Circle's
own SDK walkthrough, not a restriction the chain enforces.

### Consequence for the plan

Do not hand-roll a shielded pool. RAILGUN took years and PrivacyBoost went
through OpenZeppelin; a pool built in a hackathon window that invites real
deposits is a liability rather than a feature.

The buildable version of the same property is **stealth addresses (ERC-5564)**
on Arc: a counterparty cannot link payments, with no ZK circuit, no TEE, and no
dependency on anyone's roadmap. It is what the existing wallet's per-origin
addresses already are, formalised, and it maps directly onto Privy's HD wallets
at `m/44'/60'/0'/0/i`.

## Ledger with Privy, and where policy actually lives

**Ledger is not a first-class Privy integration.** It does not appear in Privy's
wallet list, which is `metamask, coinbase_wallet, rainbow, zerion, safe,
uniswap, kraken_wallet, binance, okx_wallet, bybit_wallet, bitget_wallet,
cryptocom, universal_profile, ronin_wallet, base_account` plus the Solana set.
`wallet_connect` *is* an available entry and Ledger Live speaks WalletConnect,
so a Ledger connects as an **external wallet**.

The consequence is structural, not cosmetic: a Ledger cannot be an embedded
wallet, and cannot be a signer or quorum member on a Privy wallet. It is a
separate account. Which is the right shape anyway — two accounts for two risk
classes.

### Privy policies are enforced where the agent cannot reach them

This is the important find, and it is verified rather than assumed. Privy
policies support:

- transfer limits, and spend caps across a time window
- allowlists and denylists for recipient addresses, for contracts, and for chains
- **granular calldata and parameter restrictions** on contract interactions
- EIP-712 typed-data validation
- time-bound signer permissions
- `DENY` takes precedence over `ALLOW`

And they are evaluated **server-side, inside a TEE, before any operation
proceeds, regardless of what the client requests**. Policies apply to both
embedded user wallets and server wallets.

That is exactly the property an agent-facing wallet needs. The threat model for
anything an AI agent can spend from is prompt injection: the agent reads web
pages, tool output and files, any of which can carry "send 500 USDC to 0x…". The
agent is the component under attack, so the agent cannot be the component
enforcing the limit. Privy already puts that enforcement somewhere a hostile
string in a context window cannot reach.

### Ledger's bounty is still unpublished

$5,000 listed for ETHOnline 2026, "Prize details coming soon" — no tracks, no
SDK requirements, nothing to build against. **Do not architect around it.**

Build the two-tier split regardless, because it stands on its own: a physical
button press is the one confirmation prompt injection cannot forge. Everything
else in an agent's world is text, and text is attackable. If Ledger's track
turns out to be about hardware confirmation, or about Clear Signing / ERC-7730 —
their current developer push, and a direct answer to the blind-calldata problem
already recorded against `wallet2`'s signing prompt — the design is already
positioned. That last sentence is a guess about Ledger's direction, not a fact.

### Resulting architecture

    agent ──MCP──▶ wallet server
                     ├─ reads                     no confirmation
                     ├─ x402 micropayments  ────▶ Privy embedded wallet
                     │                             TEE policy: cap, allowlist,
                     │                             calldata rules
                     └─ NFT / swap / transfer ───▶ Ledger over WalletConnect
                                                   physical press

Two accounts, two risk classes, with the boundary held by hardware on one side
and a TEE on the other — neither of which the agent can be talked into
overriding. See `MCP-SPEC.md` for the tool surface built on this.

## Circle Agent Stack — what is usable

Launched 11 May 2026. Five components; two of them changed the MCP spec.

### Agent Nanopayments (Gateway) — the metered tier, solved

x402-native, gas-free, sub-cent, by **batched settlement**: Gateway collects many
signed payment authorizations and settles them on chain in a single transaction,
amortising gas across thousands of payments. Not a payment channel — unified
balance with batched settlement.

This closed a hole in the first draft of `MCP-SPEC.md`, which returned a
`txHash` per payment and so assumed one transaction per 402. At sub-cent prices
that is backwards; gas would exceed the purchase. The spec now returns a
`paymentId` plus a settlement state, and decrements the budget on
*authorisation* rather than settlement — otherwise a burst of calls inside one
batch window all read the same remaining balance and collectively overspend.

### Agent Wallets

Transfer limits, time-bound limits (daily / monthly), recipient allowlists,
contract **blocklists**. Enforcement location is not documented, unlike Privy's
explicit TEE guarantee.

The blocklist/allowlist distinction matters for an agent: a blocklist cannot
anticipate a contract deployed tomorrow. So the tier where an agent can reach an
arbitrary contract stays behind Privy's allowlists and a hardware press.

### Agent Marketplace + Discovery API

A machine-readable registry the agent queries to find services to pay for. Worth
using for the demo specifically: an agent that *discovers* a service it was not
told about and then pays for it is a materially better two minutes than one
paying a hard-coded URL.

### Circle CLI, Circle Skills

CLI deposits USDC to a Gateway balance, discovers services, pays. Skills are
open source at `github.com/circlefin/skills`.

### Circle already ships an MCP server

`developers.circle.com/ai/mcp`. So "we built an MCP server for payments" is not
novel to Circle's judges. Differentiation has to be the policy model and the
per-counterparty privacy, not the existence of an MCP.

### Circle vs Privy: split by actor, not by feature

Both offer spending policy and the overlap is real. Splitting by role removes it:

| | Wallet | Tier | Why |
|---|---|---|---|
| **Agent** | Circle Agent Wallet | metered | x402-native, gas-free, batched |
| **Human** | Privy + Ledger | material | allowlists, calldata rules, physical press |

Two wallets for two actors. Both load-bearing, neither decorative.

### Unverified

- Whether Agent Wallet policy is enforced server-side by Circle. Privy states
  TEE enforcement explicitly; Circle's docs do not say.
- Whether the agent can modify its own policy. Undocumented, and load-bearing —
  if it can, the whole design fails. **Check before building.**
- Arc support for nanopayments specifically. Circle's marketing page lists Arc
  among Agent Stack chains; the nanopayments page does not confirm it.

## Chainlink CRE

Live. Workflows compile to WASM and run on DONs; Go and TypeScript SDKs.
Triggers: cron, HTTP webhook, on-chain log. Actions: HTTP GET/POST, and read
**and write** on EVM and Solana.

**Deploying to a DON requires Early Access approval.** Request via
`cre account access` or `app.chain.link/cre/request-access`; the Chainlink team
reviews and replies by email. No published turnaround. `cre workflow simulate`
works locally meanwhile — but a simulation cannot produce an on-chain state
change, and Chainlink's track requires one explicitly ("not just frontend
display").

Confidential Compute, which the $2,000 "Best Confidential Workflow" track points
at, was Early Access in early 2026 with General Access "later in 2026". Current
status unclear.

**Action: request deploy access before writing any code.** Free, minutes, and it
decides whether the track is reachable at all inside the window.

### Where CRE fits — not the policy engine

CRE must not sit in the fast path. An x402 nanopayment completes in one
request-response cycle; a DON consensus round does not fit inside that. Putting
policy evaluation there would break the product to win a prize.

The defensible role is a **circuit breaker**: a cron workflow that independently
reads the agent's actual spending from chain, compares it against the declared
policy, and on divergence writes on-chain to revoke the allowance.

- fast path (Circle / Privy) **prevents** — inline, low latency
- slow path (CRE) **detects and revokes** — independent, latency-tolerant

Defence in depth, causes an on-chain state change, and "confidential" is honest
because the policy is business logic that need not be public.

**Counterweight:** Privy and Circle already enforce policy. This is good
architecture and additional surface, for the smallest purse discussed ($2,500
total). First thing to cut if the calendar tightens.

## Can the agent modify its own policy? No.

Answered, and structurally rather than by promise.

Privy policy create/update authenticates with **basic auth — app ID and app
secret** — plus a `privy-authorization-signature` header:

    curl --request POST https://api.privy.io/v1/policies       -u "<privy-app-id>:<privy-app-secret>"       -H "privy-app-id: <privy-app-id>"       -H "privy-authorization-signature: <signature>"

The SDKs (NodeJS, Java, Go, Ruby, Rust) instantiate `PrivyClient` with the same
app credentials, server-side. Policy mutation therefore requires a credential
class the agent never holds — a different tier, not merely an unexposed method.
`privy-authorization-signature` can additionally be bound to a key quorum.

**The one condition is ours, not Privy's.** The MCP server holds that secret and
the agent talks to the MCP server, so the guarantee survives only under an
invariant recorded in `MCP-SPEC.md`: no tool may reach the policy API, and the
app secret must never appear in a tool result, a log line, or an error message.
The realistic failure is not Privy's model — it is a future "call arbitrary
Privy API" convenience tool, or a stack trace that echoes the credential.
