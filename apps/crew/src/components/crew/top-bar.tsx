/**
 * The bar across the top: what this is, and who you are on it.
 *
 * Two things, at opposite ends, because they answer opposite questions. The
 * left says what application you are looking at. The right says which wallet is
 * paying for it — which on a screen where every reply costs money is the more
 * useful of the two, and belongs where a person already looks for it.
 *
 * It replaces a small plus button tucked beside the balance in the rail. That
 * button worked and nobody would ever have found it: funding is the first thing
 * a new user has to do and the thing an established one comes back to, and both
 * were behind an icon whose meaning you had to already know.
 */
import { ChevronDown, Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortAddress, useWallet } from '@/lib/use-wallet';
import { cn } from '@/lib/utils';
import type { State } from '@/api';

/**
 * The wordmark.
 *
 * Drawn rather than an image file so it takes the theme with it — the app is
 * dark by default and a baked-in logo is the one element that would not follow
 * a switch to light.
 */
const Brand = () => (
  <div className="flex items-center gap-2">
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground"
    >
      C
    </span>
    <span className="text-sm font-semibold tracking-tight">
      Crew<span className="text-muted-foreground"> AI</span>
    </span>
  </div>
);

export const TopBar = ({ state, onWallet }: { state: State; onWallet: () => void }) => {
  const { account, ensName, connecting, connect, ready } = useWallet();

  /*
    Connecting goes straight to Privy's modal rather than through a dialog of
    ours first. Privy renders into its own portal, and opening it from inside a
    Radix dialog leaves two focus traps fighting over the same email field — the
    browser console says so out loud. Our dialog is for depositing, which only
    means anything once a wallet is attached, so it is what the connected pill
    opens instead.
  */
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-4">
      <Brand />

      {/*
        The network, small and beside the brand. It decides what every amount on
        this screen is denominated in, and a person who has switched chains and
        forgotten is otherwise reading dollars as hbar.
      */}
      <span className="hidden rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
        {state.network}
      </span>

      <div className="ml-auto flex items-center gap-2">
        {account ? (
          <button
            onClick={onWallet}
            className={cn(
              'flex items-center gap-2 rounded-full border bg-background/60 py-1 pr-2 pl-2.5 transition-colors',
              'hover:bg-accent/50',
            )}
            title={account}
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className={cn('text-xs', ensName ? 'font-medium' : 'font-mono')}>
              {ensName ?? shortAddress(account)}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <Button size="sm" className="h-8" disabled={!ready || connecting} onClick={connect}>
            <WalletIcon className="size-3.5" />
            {connecting ? 'Connecting…' : 'Connect Wallet'}
          </Button>
        )}
      </div>
    </header>
  );
};
