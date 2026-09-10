/**
 * The first thing a new user sees, which until now was nothing.
 *
 * An unfunded wallet made the runtime exit before it served a page, so the
 * opening experience was a process that would not start and an address printed
 * in a terminal nobody was looking at. This is that state rendered instead: one
 * screen, one address, and the one instruction that applies to this network.
 *
 * ## Why the instruction differs
 *
 * "Fund your wallet" is three different jobs. On a testnet there is no main
 * wallet to connect, only a faucet. On Arc the money has to be *deposited* into
 * Circle's Gateway before it can be spent, so an address holding twenty USDC
 * and nothing deposited is funded and unable to pay. Collapsing those into one
 * message is how someone ends up sending money to an address that already had
 * some.
 */
import { Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { State } from '@/api';

/** Where testnet money comes from, per network. */
const FAUCETS: Record<string, { name: string; url: string }> = {
  'hedera:testnet': { name: 'the Hedera portal', url: 'https://portal.hedera.com/faucet' },
  'eip155:84532': { name: 'the Circle faucet', url: 'https://faucet.circle.com/' },
  'eip155:5042002': { name: 'the Circle faucet', url: 'https://faucet.circle.com/' },
};

const Address = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted"
    >
      <span className="min-w-0 flex-1 font-mono text-xs break-all">{value}</span>
      <Copy className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-[11px] text-muted-foreground">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
};

export const FirstRun = ({ state }: { state: State }) => {
  const faucet = FAUCETS[state.network];
  const undeposited = state.shortfall === 'undeposited';

  return (
    <section className="flex min-h-0 items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-md flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold">
            {undeposited ? 'Almost there' : 'Fund your crew'}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {undeposited ? (
              <>
                This wallet holds {state.held ?? 'USDC'}, and none of it is deposited into Circle&rsquo;s Gateway
                — which is what payments are drawn from. Until it is deposited, the balance is visible and
                unspendable.
              </>
            ) : (
              <>
                Agents pay per call from one wallet, and this is it. Every agent draws on it under a budget you
                set and it cannot raise; none of them ever holds its key.
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            {state.network.startsWith('hedera:') ? 'Send hbar to' : 'Send USDC to'}
          </span>
          <Address value={state.account} />
          <p className="text-[11px] text-muted-foreground">
            on <span className="font-mono">{state.network}</span>
          </p>
        </div>

        {/*
          A testnet has no main wallet worth connecting — nobody keeps a balance
          on one. The faucet is the honest instruction, and offering Connect
          Wallet here would be offering a button that leads nowhere.
        */}
        {faucet && !undeposited ? (
          <a
            href={faucet.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between rounded-lg border px-3 py-2.5 text-xs transition-colors hover:bg-accent/40"
          >
            <span>
              This is a testnet — get funds from <span className="font-medium">{faucet.name}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
        ) : null}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {undeposited
            ? 'Deposit it, then this page will let you hire.'
            : 'This page updates by itself once the money lands. Nothing else to do.'}
        </p>

        <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {state.naming ? (
              <>
                Agents will be named under <span className="font-mono">{state.root}</span>, on chain, which is
                what makes revoking one work.
              </>
            ) : (
              <>
                Names are off on this chain, so agents will be local only — they will still spend under a
                budget, but there is no name to revoke.
              </>
            )}
          </p>
        </div>
      </div>
    </section>
  );
};
