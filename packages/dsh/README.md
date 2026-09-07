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

### From this repository

```sh
npm run pack --prefix packages/dsh
dsh plugin --profile desktop add "<repo>/packages/dsh/dsh-plugin-edgerouter.tgz"
```

The tarball has a stable name on purpose. A profile pins the plugin by absolute
path, so a version-stamped filename leaves that pin dangling on the next bump —
and pnpm then refuses to do anything in that profile at all, including
installing the replacement. One name keeps the pin valid; the version inside
still changes, which is what makes pnpm re-extract rather than replay its
cache.

## Setup

There isn't one. On first run the plugin generates a wallet and reports an
address in three places, so you find it wherever you happen to look:

- in the provider's settings, as `walletAddress`
- in the log, once, at startup
- in the refusal you get if you send a message before funding it

Send funds to that address and the plugin starts paying within twenty seconds.

```sh
npx dsh-plugin-edgerouter            # the address, and where to get funds
npx dsh-plugin-edgerouter watch      # wait here until they land
npx dsh-plugin-edgerouter balance    # what it holds
npx dsh-plugin-edgerouter sweep <to> # take it all back out
```

That command ships with the plugin — no repository, no toolchain. It reads the
same wallet the harness spends from, so what it reports is what will be paid
with.

**The address is not an account yet, and that is fine.** Hedera creates the
account on the first transfer to it (auto account creation, HIP-32/HIP-542), so
there is nothing to register and no fee to pay before you can receive. On EVM
chains the address is already an account. Until something arrives the provider
refuses with the address and a faucet link rather than an error about
credentials — a wallet with no money is a state, not a misconfiguration:

```
edgerouter: this wallet has no funds yet.

  Send testnet hbar to   0xf2829e87d7be67965af5fa99870917918da23b47
  Get some at            https://portal.hedera.com/faucet
  Watch for it with      npx dsh-plugin-edgerouter watch
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
  # maxAmount: '100000000'  # optional per-call ceiling. Unset takes a
                            # per-network default: 1 ℏ, or 0.1 USDC.
  baseURL: https://edgerouter-gate.prakashharsh32.workers.dev
```

`maxAmount` is a per-call ceiling, not a budget. The plugin refuses to sign
anything above it, so a gate that quotes a surprising price gets a refusal
rather than your money.

### Chains

Two, and the wallet you get depends on which you pick:

| network | asset | fund it with |
|---|---|---|
| `hedera:testnet` | HBAR | hbar, to the address shown |
| `eip155:84532` | USDC on Base Sepolia | USDC, to the address shown |

`maxAmount` is in the asset's smallest unit, and the smallest unit is not one
unit: `'100000000'` is 1 ℏ on Hedera and **100 USDC** on Base Sepolia. The same
literal, three orders of magnitude apart in what it permits — which is why the
default is per network (1 ℏ, or 0.1 USDC) rather than one number. Set it
explicitly and it means exactly what you wrote, on whichever chain.

On EVM chains there is an asymmetry worth knowing before you fund one:

> **Paying costs no gas. Leaving does.** EIP-3009 is an authorization the
> facilitator submits and pays for, so a wallet holding only USDC can spend
> indefinitely — and then cannot withdraw, because an ERC-20 transfer needs the
> chain's own token. Send a little native ETH too if you plan to sweep.

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

## Streaming

Text arrives as it is generated. The gate pipes its upstream through rather than
collecting it, and the adapter parses the frames — so a long answer appears
progressively instead of landing whole after a pause.

Payment is unaffected, and the ordering is worth knowing: the gate settles
*before* it calls its upstream, and the settlement receipt travels in a header,
which is sent ahead of the first byte of body. A streamed answer is therefore
paid for just as completely as a buffered one, and the proof arrives before the
text does.

The cost is one honest caveat. Once bytes are moving the status line is spent,
so an upstream that dies mid-answer arrives as a short answer rather than an
error — there is no way to un-send a `200`. The chunk contract still holds
(`finish` is emitted either way), and the token counts are how you tell.

## Limits, stated plainly

- **Text only.** Image and file blocks are refused rather than dropped — a model
  answering confidently about a picture it never received is worse than a
  request that fails and says why.
- **Testnets.** Hedera testnet and Base Sepolia. The settlement path is real —
  signed, submitted, confirmed on chain — and the money is not.

## Licence

MIT.
