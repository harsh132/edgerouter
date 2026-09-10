/**
 * Funding the crew from a wallet the user already has.
 *
 * The whole of this component's job is two transactions and then getting out of
 * the way. It never signs a payment: agents pay per call, unattended, and a
 * wallet popup per call would be the opposite of the thing being built. A
 * connected wallet is a funding source and an identity, not a signer.
 *
 * The amount is chosen rather than assumed, and defaults to something small.
 * Depositing is not irreversible — the balance can be withdrawn — but it is a
 * real transaction on a real chain, and a form that pre-fills someone's whole
 * balance is a form that gets it eventually.
 */
import { useEffect, useState } from 'react';
import { Wallet as WalletIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { watchWallets, connect, balanceOf, depositForCrew, type DepositStep, type Wallet } from '@/lib/wallet';
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

export const ConnectWallet = ({ route }: { route: FundingRoute }) => {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [chosen, setChosen] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState('1');
  const [step, setStep] = useState<DepositStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => watchWallets(setWallets), []);

  const link = async (wallet: Wallet) => {
    setError(null);
    try {
      const address = await connect(wallet, route);
      setChosen(wallet);
      setAccount(address);
      setBalance(await balanceOf(route, address).catch(() => null));
    } catch (problem) {
      setError((problem as Error).message.split('\n')[0] ?? 'the wallet refused');
    }
  };

  const send = async () => {
    if (!chosen || !account) return;
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
      await depositForCrew(chosen, route, account, minor, setStep);
      setBalance(await balanceOf(route, account).catch(() => null));
      /*
        Nudge the runtime to look now rather than at its next slow tick. It may
        well see nothing yet — Circle needs block confirmations before a deposit
        is spendable — which is why this is a nudge and not a claim.
      */
      await refreshFunding().catch(() => undefined);
      /*
        Deliberately not marked "funded" here. The runtime discovers the money
        by reading the chain, and a page that claimed success on its own would
        be claiming it before Circle has finalised the deposit — the balance
        needs block confirmations before Gateway will spend from it.
      */
      setStep('done');
    } catch (problem) {
      setStep(null);
      setError((problem as Error).message.split('\n')[0] ?? 'the transaction failed');
    }
  };

  if (!account) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Or fund it from a wallet you already have</span>

        {wallets.length === 0 ? (
          <p className="rounded-lg border px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            No browser wallet found. Install one, or send {route.tokenSymbol} on {route.chainName} to{' '}
            <span className="font-mono break-all">{route.depositor}</span> — though sending it to the address
            leaves it undeposited, and depositing is what makes it spendable.
          </p>
        ) : (
          wallets.map((wallet) => (
            <button
              key={wallet.name}
              onClick={() => void link(wallet)}
              className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-xs transition-colors hover:bg-accent/40"
            >
              {wallet.icon ? (
                <img src={wallet.icon} alt="" className="size-4 shrink-0 rounded" />
              ) : (
                <WalletIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 font-medium">{wallet.name}</span>
              <span className="text-[11px] text-muted-foreground">connect</span>
            </button>
          ))
        )}

        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        {chosen?.icon ? <img src={chosen.icon} alt="" className="size-4 rounded" /> : null}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{account}</span>
        {balance !== null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {show(balance, route.tokenDecimals)} {route.tokenSymbol}
          </span>
        ) : null}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Deposits straight into the crew&rsquo;s Gateway balance rather than sending to its address, so the
        money is spendable when it lands and never sits in a hot wallet as loose {route.tokenSymbol}.
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={amount}
          inputMode="decimal"
          disabled={step === 'approving' || step === 'depositing'}
          onChange={(event) => setAmount(event.target.value)}
          className="h-8 w-28 text-xs"
          aria-label={`Amount in ${route.tokenSymbol}`}
        />
        <span className="text-[11px] text-muted-foreground">{route.tokenSymbol}</span>
        <Button
          size="sm"
          className="ml-auto"
          disabled={step === 'approving' || step === 'depositing'}
          onClick={() => void send()}
        >
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
    </div>
  );
};
