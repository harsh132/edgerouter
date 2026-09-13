/**
 * The buyer: a page that pays for an answer.
 *
 * It exists because the desktop plugin, which is the better product, is a bad
 * demo — a judge has to install DSH before anything can be seen. This is the
 * same gate, the same wallet design and the same payment, on a surface anyone
 * can open.
 *
 * The layout follows the sequence rather than the data, because the sequence is
 * the argument: an agent with no account and no API key asks for something,
 * gets told the price, pays it, and is served. The steps are shown as they
 * happen for the same reason.
 */
import { useEffect, useMemo, useState } from 'react';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { localWallet } from './wallet';
import { payAndFetch, PaymentDeclined, type Paid } from './pay';

const GATE = 'https://edgerouter-gate.prakashharsh32.workers.dev/v1/chat/completions';
const ARC = 'eip155:5042002';
const DEPOSIT_USDC = '0.5';

type Balances = { wallet: string; gatewayAvailable: string };

export const App = () => {
  const wallet = useMemo(() => localWallet(), []);
  const gateway = useMemo(
    () =>
      wallet.exportPrivateKey
        ? new GatewayClient({ chain: 'arcTestnet', privateKey: wallet.exportPrivateKey() })
        : null,
    [wallet],
  );

  const [balances, setBalances] = useState<Balances | null>(null);
  const [prompt, setPrompt] = useState('Say hello in one short sentence.');
  const [steps, setSteps] = useState<{ step: string; detail?: string }[]>([]);
  const [result, setResult] = useState<Paid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'deposit' | 'pay'>(null);

  const refresh = async () => {
    if (!gateway) return;
    try {
      const b = await gateway.getBalances(wallet.address);
      setBalances({ wallet: b.wallet.formatted, gatewayAvailable: b.gateway.formattedAvailable });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // Balances are read once on load and after each action rather than polled:
    // nothing changes them except this page.
  }, []);

  const deposit = async () => {
    if (!gateway) return;
    setBusy('deposit');
    setError(null);
    try {
      await gateway.deposit(DEPOSIT_USDC);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pay = async () => {
    setBusy('pay');
    setError(null);
    setResult(null);
    setSteps([]);
    try {
      const paid = await payAndFetch(wallet, {
        url: GATE,
        network: ARC,
        body: {
          model: 'deepseek/deepseek-v4-flash',
          messages: [{ role: 'user', content: prompt }],
        },
        /*
          `detail` is omitted rather than set to undefined: under
          exactOptionalPropertyTypes an absent optional field and one holding
          undefined are different types, and only the first matches.
        */
        onStep: (step, detail) => setSteps((prior) => [...prior, { step, ...(detail ? { detail } : {}) }]),
      });
      setResult(paid);
      await refresh();
    } catch (e) {
      setError(e instanceof PaymentDeclined ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const answer =
    (result?.body as { choices?: { message?: { content?: string } }[] } | undefined)?.choices?.[0]
      ?.message?.content ?? null;

  return (
    <main>
      <header>
        <h1>edgerouter</h1>
        <p className="lead">
          Inference an agent pays for with a wallet instead of an API key. No account, nothing to
          sign up for — the gate settles before it serves, so it extends no credit and has nobody to
          identify.
        </p>
      </header>

      <section className="card">
        <h2>This agent</h2>
        <code className="addr">{wallet.address}</code>
        <p className="note">
          Key held in <strong>{wallet.custody}</strong>. Testnet only — anything with a real balance
          belongs behind a wallet whose key is not in the page.
        </p>
        <div className="rows">
          <div>
            <span className="label">Wallet USDC</span>
            <span className="value">{balances?.wallet ?? '—'}</span>
          </div>
          <div>
            <span className="label">Gateway balance</span>
            <span className="value">{balances?.gatewayAvailable ?? '—'}</span>
          </div>
        </div>
        <div className="row">
          <button onClick={() => void refresh()}>Refresh</button>
          <button onClick={() => void deposit()} disabled={busy !== null}>
            {busy === 'deposit' ? 'Depositing…' : `Deposit ${DEPOSIT_USDC} USDC`}
          </button>
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
            Circle faucet
          </a>
        </div>
        <p className="note">
          Circle Gateway pays from a balance you deposit, not from the wallet directly — so funding
          the address is the first step and depositing is the second.
        </p>
      </section>

      <section className="card">
        <h2>Buy an answer</h2>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
        <div className="row">
          <button className="primary" onClick={() => void pay()} disabled={busy !== null}>
            {busy === 'pay' ? 'Paying…' : 'Pay and ask'}
          </button>
        </div>

        {steps.length > 0 && (
          <ol className="steps">
            {steps.map((s, i) => (
              <li key={i}>
                {s.step}
                {s.detail ? <span className="note"> — {s.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}

        {error && <p className="error">{error}</p>}

        {result && (
          <div className="answer">
            <p>{answer ?? JSON.stringify(result.body).slice(0, 400)}</p>
            <p className="note">
              {result.quote ? `${result.quote.amount} smallest units on ${result.quote.network}` : ''}
              {result.settlement ? ` · batch ${result.settlement}` : ''} · {result.elapsedMs}ms
            </p>
          </div>
        )}
      </section>
    </main>
  );
};
