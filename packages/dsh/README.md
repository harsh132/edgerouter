# dsh-plugin-edgerouter

A DeepSeek Harness model provider that pays for its own inference.

No account, no signup, no API key, and nothing to type. The plugin generates a
wallet, shows you an address, and buys tokens per call over
[x402](https://x402.org) — an HTTP payment protocol built on the long-unused
`402 Payment Required` status.

```
harness asks for a completion
  → gate answers 402 with a price
  → the plugin signs a transfer
  → the request is retried, paid
  → the answer comes back
```

## Why this is a plugin and not a setting

The harness can already talk to any OpenAI-compatible endpoint through a
hand-declared `llm-pi-ai` route. Pointed at an edgerouter gate, that works right
up to the `402` — which nothing in the harness knows how to pay. pi-ai's
`transport` option chooses SSE or WebSocket, not a request implementation, so
there is no seam to hand it a paying fetch.

Owning the adapter is what puts payment in the request path. That is the whole
plugin; everything else is packaging.

## Install

In DSH Desktop, open the terminal from the tray, then:

```sh
dsh plugin add dsh-plugin-edgerouter
```

Restart Desktop afterwards so the new bundle enters the Loader composition.

## Setup

There isn't one. On first run the plugin generates a wallet and logs an address:

```
llm-edgerouter: send hbar to 0xf2829e87d7be67965af5fa99870917918da23b47 to start paying
```

Send hbar to that address from any wallet, exchange, or the
[testnet faucet](https://portal.hedera.com/faucet). The plugin notices within
twenty seconds and starts paying.

**The address is not an account yet, and that is fine.** Hedera creates the
account on the first transfer to it (auto account creation, HIP-32/HIP-542), so
there is nothing to register and no fee to pay before you can receive. Until
something arrives the provider refuses with the address rather than an error
about credentials — a wallet with no money is a state, not a misconfiguration.

Inspect it from a terminal:

```sh
bun packages/sdk/wallet.ts address     # where to send funds
bun packages/sdk/wallet.ts balance     # what it holds, and its account id
bun packages/sdk/wallet.ts watch       # poll until funds land
bun packages/sdk/wallet.ts sweep 0.0.x # move everything back out
```

### About that key

The key lives in `~/.edgerouter/<network>.wallet.json`, mode `0600` where that
means anything, **and it is not encrypted**.

That is a choice, not an oversight. Encryption needs a key, and the only key
available without prompting on every launch would sit beside the ciphertext,
which protects nothing while looking like it does. A passphrase would genuinely
protect it — and would also mean typing a passphrase before an agent can run
unattended, which is the property this design exists to provide.

So the honest framing: this is a hot wallet holding what you chose to put in
it. Fund it like a coat pocket, not a savings account. `sweep` is there because
a wallet you cannot leave is a hostage.

## Configure

Everything has a working default. This is the whole surface:

```yaml
llm-edgerouter:
  wallet: local             # local | environment | authority
  network: hedera:testnet
  maxAmount: '100000000'    # ceiling for ONE call, in tinybars. 1 ℏ.
  baseURL: https://edgerouter-gate.prakashharsh32.workers.dev
```

`maxAmount` is a per-call ceiling, not a budget. The plugin refuses to sign
anything above it, so a gate that quotes a surprising price gets a refusal
rather than your money.

### Other places the money can come from

**`environment`** — for CI, or an account you already have. Reads
`HEDERA_ACCOUNT_ID` and `HEDERA_PRIVATE_KEY`. Note that DSH Desktop launches
from the tray and inherits no shell, so these have to be set as user-level
environment variables to reach it.

**`authority`** — no key at all. Payments are signed by a *budget authority*
running elsewhere, against an allowance this agent was delegated:

```yaml
llm-edgerouter:
  wallet: authority
  authorityUrl: http://127.0.0.1:8790
```

with the capability in `EDGEROUTER_CAPABILITY`. This is how a sub-agent spends
without being trusted with a wallet — see below.

## Delegation: spending without a key

Start an authority over a funded wallet:

```sh
bun packages/sdk/authority-serve.ts --fund 1.0
```

It prints one root capability. From it you can mint children, each with its own
budget, expiry, and per-call ceiling — and each strictly narrower than its
parent, because narrowing is the only operation the algebra can express.

A sub-agent holding a child capability signs nothing itself. It asks the
authority, the authority charges that payment to the sub-agent's node, and when
the node is empty the answer is no. Revoking is emptying: there is no
revocation list, because a capability over an empty balance already buys
nothing.

Two bounds apply to every payment and neither can widen the other:

| bound | where | what it limits |
|---|---|---|
| `maxAmount` | here, per call | what this client will sign for |
| ceiling | the capability | what this allowance permits per call |
| budget | the authority | what this allowance has left, in total |

The budget is the one that could not live at the gate. A running total is
state, and the gate is stateless by design — so it lives in the process that
already had to hold the key.

## What it refuses, and why that matters

Every refusal happens **before** anything is signed, and each is a distinct
thing to fix rather than one opaque failure:

| code | meaning |
|---|---|
| `PAYMENT_OVER_CAP` | the quote exceeded `maxAmount` |
| `PAYMENT_NETWORK_UNAVAILABLE` | the gate does not quote on your network |
| `PAYMENT_SELF` | the gate's `payTo` is your own account |
| `PAYMENT_BAD_QUOTE` | the 402 was malformed, or priced at zero |
| `MISSING_CREDENTIAL` | no wallet yet — the message carries the address |

The signer authorises what it is handed and chooses nothing. That separation is
what makes the cap meaningful — a signer that picked its own amounts could not
be capped by its caller.

## What it costs

Every paid call is logged with its price, a running session total, and the
settlement transaction id, because a provider that spends money invisibly is
not one anybody should install.

```
paid 0.01234 ℏ (total 0.03702 ℏ over 3) for deepseek/deepseek-chat
  — sign 15ms, call 9939ms — 0.0.7162784@1788769080.588629774
```

## Limits, stated plainly

- **Text only.** Image and file blocks are refused rather than dropped — a model
  answering confidently about a picture it never received is worse than a
  request that fails and says why.
- **Not streaming.** The gate buffers its upstream before answering, so there is
  no incremental data to forward. The answer arrives whole.
- **Testnet.** Hedera testnet today. The settlement path is real; the money is
  not.

## Licence

MIT.
