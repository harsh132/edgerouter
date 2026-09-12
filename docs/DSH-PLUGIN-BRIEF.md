# Brief: the DeepSeek Harness plugin

Handoff for an agent starting `packages/dsh`. Written 2026-09-07, against
commit `c9a4927`.

Read this whole file before writing code. The last section lists what is *not*
known, and one of those unknowns decides the plugin's shape.

---

## The goal, in one paragraph

**edgerouter** lets an AI agent pay for inference with a wallet instead of an
account. There is no signup, no API key, no dashboard. A user connects a wallet,
gets a capability token scoped to a budget, and points any OpenAI-compatible
client at our gate. The gate answers `402 Payment Required`, the client pays
per call over x402, and the answer comes back. The service is stateless: it
holds no key, no session, and no record of who anyone is.

The DSH plugin is how a person actually uses this. Without it, edgerouter is a
URL. With it, someone installs a plugin, connects a wallet, and their harness
starts paying for its own tokens.

This is for **ETHOnline 2026**. The plugin is distribution, not a prize track —
it is the thing that makes the demo a product rather than a curl command.

---

## What already exists, and works

Repo: `C:\workspace\edgerouter` (private, `harsh132/edgerouter`). Bun
workspace, TypeScript, no build step for the packages.

```
packages/core      capability tokens: mint, attenuate, verify. No dependencies.
packages/sdk       the x402 client. THIS IS WHAT YOU WRAP.
apps/gate          the Cloudflare Worker. OpenAI-compatible, x402-gated.
```

### The gate

`apps/gate/src/index.ts`. Routes:

| route | auth | cost |
|---|---|---|
| `GET /health` | none | free |
| `GET /v1/models` | none | free |
| `POST /v1/chat/completions` | capability + payment | paid |

The paid route is OpenAI-compatible and proxies OpenRouter upstream. It refuses
in a fixed order: capability first (401), then policy (403), then payment (402).
**A client with no capability never sees a 402** — it gets a 401 and no quote.
That ordering matters for your error handling.

Run it:

```bash
cd C:\workspace\edgerouter
bun run dev            # wrangler dev; note the port it prints, often 8789
```

Mint a capability (dev only, reads `apps/gate/.dev.vars`):

```bash
bun apps/gate/mint-token.ts            # prints er_<base64> on stdout
```

### The SDK — what you are building on

`packages/sdk/src/pay/`:

- `client.ts` — `payAndFetch(url, { signer, maxAmount, init })`. Does the whole
  402 loop: request, read `accepts[]`, choose, check, sign, retry. Returns the
  response plus `quote`, `settlement`, `signingMs`, `paidRequestMs`.
- `hedera.ts` — `hederaSigner({ accountId, privateKey, network })`, built on
  `@x402/hedera` (the reference implementation, by the x402 maintainers).
- `types.ts` — `PaymentSigner`, `PaymentRefused` and its `reason` values.

`payAndFetch` refuses *before* signing on: wrong network, amount over the
caller's cap, non-integer or zero amount, and paying your own account. The
signer authorises what it is handed and chooses nothing. Preserve that split —
it is what makes a spend cap meaningful.

```bash
bun packages/sdk/check.ts    # 38 checks, no network, no key
bun run check                # everything: core + sdk + gate, 143 checks
bun run typecheck            # use `bun run typecheck`, NEVER bare `npx tsc`
```

### Proven end to end

Four real settlements on `hedera:testnet` through Blocky402 on 2026-09-07, all
`SUCCESS` on chain. Example: `0.0.7162784@1788751655.677586974`.

Measured, and relevant to you because it lands in the user's latency:

| phase | time |
|---|---|
| client signing | 27–35 ms |
| facilitator verify | 0.5–1.1 s |
| upstream (OpenRouter) | 3.6–6.1 s |
| facilitator settle | 1.7–3.4 s |

The two facilitator calls are **~40% of a request**. See
`docs/BATCH-SETTLEMENT.md`. Do not design the plugin as though payment is free;
a naive implementation that pays per call will feel slow, and whether you can
hide that latency is a real design question for you.

---

## What the plugin has to do

### The core insight — read this before designing anything

DSH already supports custom OpenAI-compatible providers with a base URL and an
API key. So a user can point DSH at edgerouter **today**, with no plugin at
all — and every request will come back `402`, which stock DSH cannot pay.

**The plugin's entire reason to exist is turning that 402 into a payment.**
It is `payAndFetch` in the request path, plus somewhere to keep a key and a
budget. Everything else is packaging.

That means the smallest useful version is small. Prefer shipping that and
growing it over designing a large surface first.

### Minimum viable plugin

1. Register edgerouter as a model provider (or wrap the HTTP client of one).
2. On `402`, run the payment loop and retry. On success, return the response as
   if nothing happened.
3. Configuration: gate URL, capability token, Hedera account id, private key,
   per-call cap.
4. Surface refusals as something a user can act on. `PaymentRefused.reason` is
   already a named enum — `over_max_amount` should not read as "request failed".

### Worth having, in rough order

- A visible running total. People paying per call want to see it.
- A session budget on top of the per-call cap.
- `GET /v1/models` for the model list — it is free and unauthenticated.
- Balance check on startup; a friendly error beats a settlement failure.

### Explicitly out of scope for now

The wallet layer does not exist yet. There is **no Privy integration, no HD
derivation, no delegation, no ENS**. The plugin configures a raw Hedera account
id and key, and that is fine for this stage. Do not build the wallet layer as a
side quest — it is `packages/sdk` part 7 and belongs there, not in the plugin.

---

## DeepSeek Harness — verified facts

Repo `deepseek-ai/deepseek-harness`, MIT, TypeScript, master branch, ~214k
stars, pushed 2026-09-04. Built on **Cordis**, a plugin/DI framework — "everything
is a plugin": models, tools, sessions, sandboxes, the UI.

**It is in developer preview and the README warns of compatibility-breaking
changes.** Pin whatever version you develop against and record it.

Docs that matter, all in the repo:

```
docs/cordis-primer.md                        start here
docs/cordis-tutorial/01-first-plugin.md      through 07-into-the-harness.md
docs/cordis-api/{context,service,registry,events,fiber}.md
docs/cookbook/adding-an-llm-adapter.md       ← closest thing to our task
docs/cookbook/adding-a-tool.md
docs/cookbook/adding-a-settings-card.md      for configuration UI
docs/cookbook/adding-a-package.md
docs/architecture.md
docs/capability-seams.md
```

Reference implementations to copy the shape of, in the repo:

```
packages/llm/llm-pi-ai/          a third-party LLM provider — the closest model
packages/llm/llm-deepseek/       the first-party one
packages/llm/llm-retry/          wraps requests; likely relevant to 402 retry
packages/credentials/            where secrets are meant to live
packages/settings/               configuration surface
```

`packages/llm/llm-retry` is worth reading early. If DSH already has a
request-wrapping seam for retries, a 402 retry may belong there rather than in
a bespoke provider — that would make the plugin much smaller.

There is a community plugin registry at `dshplugin.store`. Look at how a
published plugin is packaged before deciding on your own layout.

---

## Constraints — these are not negotiable

**Testnet only.** Everything so far is `hedera:testnet`. Do not configure or
suggest mainnet.

**Never handle a private key in conversation.** The user pastes keys into a
gitignored `.env`; you read them from `process.env` and never print, log, or
commit them. `parsePrivateKey` in `hedera.ts` deliberately keeps the key out of
its own error messages — keep that property.

**Do not execute a mainnet transfer, ever.** Testnet HBAR is faucet-funded and
valueless, so test transactions there are ordinary engineering. Real funds are
the user's to move, not yours.

**Verify before claiming.** Use `bun run typecheck`, never bare `npx tsc` — in
this environment `npx tsc` resolves to an unrelated package and reports success
for broken code. This has already produced three false "clean" claims.

**Heredocs break on TypeScript.** Backticks and `${}` in a bash heredoc will
fail or corrupt the file. Use the Write tool. Python replacements with `\n` in
the replacement string have twice written literal newlines into string
literals — use Edit for anything containing escapes.

---

## Accounts and configuration

```
payTo      0.0.10400448     receives payment (the operator)
payer      0.0.10400904     the test wallet, ~100 ℏ, ED25519
feePayer   0.0.7162784      Blocky402's own account, pays Hedera fees
facilitator https://api.testnet.blocky402.com
mirror      https://testnet.mirrornode.hedera.com
```

The gate quotes `0.01234 ℏ` for `deepseek/deepseek-chat` — 1,234,000 tinybars,
about $0.001. Prices live in `apps/gate/src/pricing.ts` in USD minor units and
are converted per network by `unitsPerUsdMinor`; HBAR is 8 decimals, USD minor
is 6, and getting that wrong quotes a thousandth of the price *and settles
cleanly*. If you touch pricing, read the comment in `networks.ts` first.

Working example, end to end:

```bash
EDGEROUTER_TOKEN=$(bun apps/gate/mint-token.ts 2>/dev/null) \
bun run pay-check http://127.0.0.1:8789/v1/chat/completions
```

`packages/sdk/pay-check.ts` is the reference for the whole flow. Read it.

---

## Unknowns — resolve these before designing

1. **Which DSH seam is right.** A custom LLM provider, a wrapper around an
   existing one, or a request middleware? `adding-an-llm-adapter.md` and
   `llm-retry` should settle it. This decides the plugin's shape, so do it
   first.
2. **How DSH plugins are packaged and distributed.** In-repo package versus
   standalone npm module versus something the plugin store expects.
3. **Where credentials belong.** `packages/credentials/` exists; find out
   whether a plugin is expected to use it rather than reading `process.env`.
4. **Whether the harness can show a running cost.** If there is no seam for
   ambient UI, the budget display may have to live in a settings card or a
   tool.
5. **Whether DSH runs on Windows.** The primary machine here is Windows 11.
   Unverified. Check early; it is a bad thing to discover late.

## Not yet decided, above your level

Whether to build our own settlement component with escrow. Batching would take
both facilitator calls off the critical path — roughly 40% of request latency —
but Blocky402 does not offer batch settlement, so it means running more
infrastructure. `docs/BATCH-SETTLEMENT.md` has the evidence. Do not start this;
just know the per-call latency you are designing around may not be permanent.

## Definition of done, first milestone

A DSH user installs the plugin, configures a gate URL, capability token, Hedera
account and cap, and has a conversation whose tokens were paid for on chain.
The transaction ids are checkable on HashScan. A cap that is too low produces a
clear refusal rather than a stack trace.

Checks pass, typecheck is clean, and anything you learned that contradicts this
brief is written back into it.
