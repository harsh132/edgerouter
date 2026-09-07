# dsh-plugin-edgerouter

A DeepSeek Harness model provider that pays for its own inference.

No account, no signup, no API key. You give it a wallet and a budget, and the
harness buys tokens per call over [x402](https://x402.org) — an HTTP payment
protocol built on the long-unused `402 Payment Required` status.

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

For the CLI, the same command works against your profile.

## Configure

```yaml
llm-edgerouter:
  baseURL: https://your-gate.example
  network: hedera:testnet
  accountId: 0.0.1234567
  maxAmount: '100000000'    # ceiling for ONE call, in tinybars. 1 ℏ.
```

Secrets are never in this file. Three environment variables:

| variable | what |
|---|---|
| `EDGEROUTER_TOKEN` | your capability token (`er_…`) |
| `HEDERA_ACCOUNT_ID` | payer account, if not set as `accountId` above |
| `HEDERA_PRIVATE_KEY` | the payer's key — this signs the transfers |

`maxAmount` is a per-call ceiling, not a budget. The plugin refuses to sign
anything above it, so a gate that quotes a surprising price gets a refusal
rather than your money.

## What it refuses, and why that matters

Every refusal happens **before** anything is signed, and each is a distinct
thing to fix rather than one opaque failure:

| code | meaning |
|---|---|
| `PAYMENT_OVER_CAP` | the quote exceeded `maxAmount` |
| `PAYMENT_NETWORK_UNAVAILABLE` | the gate does not quote on your network |
| `PAYMENT_SELF` | the gate's `payTo` is your own account |
| `PAYMENT_BAD_QUOTE` | the 402 was malformed, or priced at zero |
| `MISSING_CREDENTIAL` | no account id or key |

The signer authorises what it is handed and chooses nothing. That separation is
what makes the cap meaningful — a signer that picked its own amounts could not
be capped by its caller.

## What it costs

Every paid call is logged with its price, a running session total, and the
settlement transaction id, because a provider that spends money invisibly is not
one anybody should install.

```
paid 0.01234 ℏ (total 0.03702 ℏ over 3) for deepseek/deepseek-chat
  — sign 28ms, call 6436ms — 0.0.7162784@1788761241.270338530
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
