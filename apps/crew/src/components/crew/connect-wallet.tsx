/**
 * Choosing a wallet, and putting money into the crew with it.
 *
 * The connection itself lives in `useWallet`, so this is only the two screens
 * around it: pick a wallet when there is none, and deposit when there is. That
 * split is what lets the bar at the top and this panel be the same connection
 * rather than two that can disagree.
 *
 * It never signs a payment. Agents pay per call, unattended, several times a
 * minute — routing that through a wallet popup would not be a variation on this
 * product but the opposite of it. A connected wallet is a funding source and an
 * identity.
 *
 * The amount is chosen rather than assumed, and starts small. Depositing is not
 * irreversible — the balance can be withdrawn — but it is a real transaction on
 * a real chain, and a form that pre-fills someone's whole balance is a form
 * that eventually takes it.
 */
import { useState } from 'react';
import { Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { depositForCrew, type DepositStep } from '@/lib/wallet';
import { shortAddress, useWallet } from '@/lib/use-wallet';
import { refreshFunding, type FundingRoute } from '@/api';

/** Smallest units to a readable string, without going through a float. */
const show = (minor: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals);
  const rest = (minor % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${minor / scale}${rest ? `.${rest}` : ''}`;
};

const toMinor = (text: string, decimals: number): bigint => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('not an amount');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) throw new Error('too many decimal places');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
};

/**
 * The button that opens Privy's modal.
 *
 * There is no list here any more. Privy owns discovery — extensions,
 * WalletConnect, email, social — and a second list beside its modal would be
 * this app guessing at what it found.
 */
export const WalletPicker = ({ route }: { route: FundingRoute }) => {
  const { connect, connecting, error, ready } = useWallet();

  return (
    <div className="flex flex-col gap-2">
      <Button disabled={!ready || connecting} onClick={connect}>
        <WalletIcon className="size-3.5" />
        {connecting ? 'Connecting…' : 'Connect a wallet'}
      </Button>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A browser extension, WalletConnect, or an email — whichever you have. Or send {route.tokenSymbol} on{' '}
        {route.chainName} to <span className="font-mono break-all">{route.depositor}</span>, though that leaves
        it undeposited and depositing is what makes it spendable.
      </p>

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
};

/** Depositing, once a wallet is connected. */
export const DepositPanel = ({ route }: { route: FundingRoute }) => {
  const { wallet, account, ensName, balanceMinor, disconnect, refresh } = useWallet();
  const [amount, setAmount] = useState('1');
  const [step, setStep] = useState<DepositStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!wallet || !account) return null;
  const busy = step === 'approving' || step === 'depositing';

  const send = async () => {
    setError(null);
    let minor: bigint;
    try {
      minor = toMinor(amount, route.tokenDecimals);
    } catch {
      setError(`That is not an amount in ${route.tokenSymbol}.`);
      return;
    }
    if (minor <= 0n) {
      setError('Deposit more than nothing.');
      return;
    }

    try {
      await depositForCrew(wallet, route, account, minor, setStep);
      await refresh();
      /*
        Nudge the runtime to look now rather than at its next slow tick. It may
        well see nothing yet — Circle needs block confirmations before a deposit
        is spendable — which is why this is a nudge and not a claim.
      */
      await refreshFunding().catch(() => undefined);
      setStep('done');
    } catch (problem) {
      setStep(null);
      setError((problem as Error).message.split('\n')[0] ?? 'the transaction failed');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2.5">
        {wallet.icon ? (
          <img src={wallet.icon} alt="" className="size-4 shrink-0 rounded" />
        ) : (
          <WalletIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{ensName ?? shortAddress(account)}</div>
          {ensName ? (
            <div className="truncate font-mono text-[10px] text-muted-foreground">{account}</div>
          ) : null}
        </div>
        {balanceMinor !== null ? (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {show(balanceMinor, route.tokenDecimals)} {route.tokenSymbol}
          </span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Deposits straight into the crew&rsquo;s Gateway balance rather than sending to its address, so the money
        is spendable when it lands and never sits in a hot wallet as loose {route.tokenSymbol}.
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={amount}
          inputMode="decimal"
          disabled={busy}
          onChange={(event) => setAmount(event.target.value)}
          className="h-8 w-28 text-xs"
          aria-label={`Amount in ${route.tokenSymbol}`}
        />
        <span className="text-[11px] text-muted-foreground">{route.tokenSymbol}</span>
        <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void send()}>
          {step === 'approving' ? 'Approving…' : step === 'depositing' ? 'Depositing…' : 'Deposit'}
        </Button>
      </div>

      {step === 'done' ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Sent. Circle needs a few blocks to finalise it before the balance can be spent; this page updates
          itself when it can.
        </p>
      ) : null}

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

      <button
        onClick={disconnect}
        className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline"
      >
        {/*
          "Forget" rather than "disconnect": there is no way to tell an extension
          to stop knowing you, and only this page's copy of the address goes.
        */}
        Forget this wallet
      </button>
    </div>
  );
};

/** Both halves, for places that just want the whole flow. */
export const ConnectWallet = ({ route }: { route: FundingRoute }) => {
  const { account } = useWallet();
  return account ? (
    <DepositPanel route={route} />
  ) : (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">Or fund it from a wallet you already have</span>
      <WalletPicker route={route} />
    </div>
  );
};
