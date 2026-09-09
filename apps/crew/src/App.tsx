/**
 * The room: a rail of agents, a thread with one of them, and its money.
 *
 * The layout is the familiar one — workers on the left, conversation in the
 * middle, detail on the right — because the thing being shown is unfamiliar
 * enough on its own. What is different sits in two places: every reply carries
 * what it cost, and the right-hand panel is a budget rather than a settings
 * page. An agent here is a name on a chain with money attached, and both are
 * things you can take away while it is mid-sentence.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { assign, fire, halt, hire, useCrew, type Agent, type State, type Step, type Task } from './api';

/* ---------------------------------------------------------------- helpers */

/**
 * An agent's colour, derived from its name rather than stored.
 *
 * Same agent, same colour, in the rail and the thread and the ledger, with
 * nothing to keep in sync. The hues are spaced far enough apart that a roster
 * of eight never has two that read as the same.
 */
const hueOf = (seed: string): number => {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return hash % 360;
};

const initials = (label: string): string =>
  label
    .split('-')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

const when = (at: number): string => {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/** Smallest units to a readable figure, using the unit the network deals in. */
const money = (network: string, minor: string): string => {
  const value = BigInt(minor);
  if (network.startsWith('hedera:')) {
    const whole = value / 100_000_000n;
    const rest = (value % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
    return `${whole}${rest ? `.${rest}` : ''} ℏ`;
  }
  const whole = value / 1_000_000n;
  const rest = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''} USDC`;
};

const lastLine = (agent: Agent): string => {
  const task = agent.tasks.at(-1);
  if (agent.status === 'revoked') return 'revoked — its name no longer resolves';
  if (agent.running) return task?.steps.at(-1)?.text?.slice(0, 90) || 'working…';
  if (!task) return agent.brief.slice(0, 90) || 'idle';
  if (task.outcome && task.outcome !== 'finished') return task.outcome;
  return task.steps.at(-1)?.text?.slice(0, 90) || task.prompt.slice(0, 90);
};

/* ------------------------------------------------------------------ blob */

const Blob = ({
  agent,
  size = 'md',
}: {
  agent: Agent;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const hue = hueOf(agent.label);
  const dead = agent.status === 'revoked';
  return (
    <div
      className="blob"
      data-size={size}
      data-dim={dead}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 78% 68%), hsl(${(hue + 34) % 360} 72% 56%))` }}
    >
      {initials(agent.label)}
      {size !== 'sm' && (agent.running || dead || agent.status === 'broke') ? (
        <i className="pip" data-state={agent.running ? 'running' : agent.status} />
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------- rail */

const Rail = ({
  state,
  selected,
  onSelect,
  onNew,
  log,
}: {
  state: State;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  log: string[];
}) => (
  <div className="rail">
    <div className="rail-head">
      <div className="rail-title">Crew</div>
      <button className="btn" onClick={onNew} title="Hire an agent" style={{ padding: '5px 11px' }}>
        +
      </button>
    </div>

    <div className="rail-list">
      {state.agents.length === 0 ? (
        <p style={{ color: 'var(--ink-faint)', fontSize: 12, padding: '10px 8px', lineHeight: 1.6, margin: 0 }}>
          No agents yet. Each one gets a name on ENS and a budget it cannot raise.
        </p>
      ) : null}

      {state.agents.map((agent) => (
        <button
          key={agent.id}
          className="row"
          data-active={agent.id === selected}
          data-revoked={agent.status === 'revoked'}
          onClick={() => onSelect(agent.id)}
        >
          <Blob agent={agent} />
          <div style={{ minWidth: 0 }}>
            <div className="row-top">
              <div className="row-name">{agent.label}</div>
              <div className="row-when">{when(agent.tasks.at(-1)?.startedAt ?? agent.createdAt)}</div>
            </div>
            <div className="row-sub">{lastLine(agent)}</div>
          </div>
        </button>
      ))}
    </div>

    <div className="rail-foot">
      {log.length > 0 ? (
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', lineHeight: 1.5 }}>{log.at(-1)}</div>
      ) : null}
      <div className="wallet-line">
        <i className="dot" />
        <span title={state.account}>{state.account}</span>
        <b>{state.spendable}</b>
      </div>
    </div>
  </div>
);

/* ----------------------------------------------------------------- thread */

const Thread = ({ agent, state }: { agent: Agent; state: State }) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  const stepCount = agent.tasks.reduce((total, task) => total + task.steps.length, 0);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stepCount, agent.id, agent.running]);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    setError(null);
    try {
      await assign(agent.id, prompt);
    } catch (problem) {
      setError((problem as Error).message);
      setDraft(prompt);
    }
  };

  const dead = agent.status === 'revoked' || agent.status === 'broke';

  return (
    <div className="thread">
      <div className="thread-head">
        <Blob agent={agent} size="sm" />
        <div style={{ minWidth: 0 }}>
          <div className="thread-head-name">{agent.label}</div>
          <div className="thread-head-sub">{agent.name ?? 'no ENS name'}</div>
        </div>
      </div>

      <div className="thread-body">
        {agent.tasks.length === 0 ? (
          <div className="empty">
            <div className="empty-inner">
              <Blob agent={agent} size="lg" />
              <h3>{agent.label}</h3>
              <p style={{ margin: 0 }}>{agent.brief}</p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-faint)' }}>
                Give it a task. Every reply it writes is bought from the gate with its own budget.
              </p>
            </div>
          </div>
        ) : null}

        {agent.tasks.map((task) => (
          <TaskView key={task.id} task={task} agent={agent} />
        ))}

        {agent.running ? (
          <div className="thinking">
            <i />
            <i />
            <i />
          </div>
        ) : null}

        <div ref={bottom} />
      </div>

      <div className="composer">
        {error ? <div className="error" style={{ marginBottom: 10 }}>{error}</div> : null}
        <div className="composer-box">
          <textarea
            rows={1}
            value={draft}
            placeholder={dead ? `${agent.label} cannot spend any more` : `Give ${agent.label} a task`}
            disabled={dead}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {agent.running ? (
            <button className="send" data-stop="true" title="Stop" onClick={() => void halt(agent.id)}>
              ■
            </button>
          ) : (
            <button className="send" disabled={dead || !draft.trim()} onClick={() => void send()} title="Send">
              ↑
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 8 }}>
          {money(agent.network, agent.budgetMinor) === agent.budget ? null : null}
          {agent.spent} spent of {agent.budget} · {state.network}
        </div>
      </div>
    </div>
  );
};

const TaskView = ({ task, agent }: { task: Task; agent: Agent }) => (
  <>
    <div className="stamp">{when(task.startedAt)}</div>
    <div className="bubble" data-from="you">
      {task.prompt}
    </div>
    {task.steps.map((step) => (
      <StepView key={`${task.id}-${step.n}`} step={step} agent={agent} />
    ))}
    {task.outcome && task.outcome !== 'finished' ? (
      <div className="outcome" data-bad={task.outcome.startsWith('stopped —') || task.outcome.startsWith('failed')}>
        {task.outcome}
      </div>
    ) : null}
  </>
);

/**
 * One paid step: what the agent said, and what saying it cost.
 *
 * The receipt is under the message rather than in a total somewhere, because
 * the claim being demonstrated is per-call — this sentence was bought, on a
 * chain, for this much, in this long.
 */
const StepView = ({ step, agent }: { step: Step; agent: Agent }) => (
  <>
    <div className="bubble" data-from="them">
      {step.text || '…'}
    </div>
    <div className="receipt">
      <b>{money(agent.network, step.costMinor)}</b>
      <span>·</span>
      <span>{(step.ms / 1000).toFixed(1)}s</span>
    </div>
  </>
);

/* ----------------------------------------------------------------- detail */

const Detail = ({ agent, state }: { agent: Agent; state: State }) => {
  const [busy, setBusy] = useState(false);
  const spent = Number(BigInt(agent.spentMinor));
  const budget = Number(BigInt(agent.budgetMinor));
  const share = budget === 0 ? 0 : Math.min(100, (spent / budget) * 100);
  const level = share > 90 ? 'bad' : share > 65 ? 'warn' : 'ok';

  const steps = useMemo(
    () => agent.tasks.flatMap((task) => task.steps).slice(-14).reverse(),
    [agent.tasks],
  );

  return (
    <div className="detail">
      <div className="detail-hero">
        <Blob agent={agent} size="lg" />
        <div style={{ fontWeight: 600 }}>{agent.label}</div>
        <div className="ens" data-none={!agent.name}>
          {agent.name ?? (state.naming ? 'name could not be minted' : 'names are off on this chain')}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Budget</div>
        <div className="money">
          <b>{agent.spent}</b>
          <span>of {agent.budget}</span>
        </div>
        <div className="meter">
          <i style={{ width: `${share}%` }} data-level={level} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', lineHeight: 1.5 }}>
          Enforced by the authority holding the wallet, not by the agent. It has no key and cannot raise this.
        </div>
      </div>

      <div className="section">
        <div className="section-title">Identity</div>
        <dl className="facts">
          <div className="fact">
            <dt>pays from</dt>
            <dd title={agent.account}>{agent.account ? `${agent.account.slice(0, 10)}…` : '—'}</dd>
          </div>
          <div className="fact">
            <dt>model</dt>
            <dd>{agent.model}</dd>
          </div>
          <div className="fact">
            <dt>network</dt>
            <dd>{agent.network}</dd>
          </div>
          <div className="fact">
            <dt>hired</dt>
            <dd>{when(agent.createdAt)}</dd>
          </div>
        </dl>
      </div>

      {steps.length > 0 ? (
        <div className="section">
          <div className="section-title">Ledger</div>
          <div className="ledger">
            {steps.map((step) => (
              <div className="ledger-row" key={`${step.at}-${step.n}`}>
                <div className="ledger-n">{step.n}</div>
                <div className="ledger-text">{step.text || 'in flight'}</div>
                <div className="ledger-cost">{money(agent.network, step.costMinor)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {agent.status !== 'revoked' ? (
        <button
          className="btn"
          data-kind="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await fire(agent.id);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Revoking…' : agent.name ? 'Revoke on chain' : 'Revoke'}
        </button>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--ink-faint)', lineHeight: 1.6 }}>
          Its address record was cleared, so the authority refuses to sign for it — including on a restart, and
          including mid-task.
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ hire */

const HireSheet = ({ state, onClose }: { state: State; onClose: () => void }) => {
  const [label, setLabel] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('');
  const [model, setModel] = useState(state.models[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hedera = state.network.startsWith('hedera:');
  const unit = hedera ? 'ℏ' : 'USDC';
  const scale = hedera ? 100_000_000n : 1_000_000n;

  const submit = async () => {
    setError(null);
    const amount = Number(budget);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError(`How much may it spend, in ${unit}?`);
      return;
    }
    setBusy(true);
    try {
      await hire({
        label,
        brief: brief.trim() || 'A helpful agent.',
        model,
        /*
          Converted through a string rather than float arithmetic on the
          smallest unit — 0.1 ℏ is 10000000 tinybars exactly, and going via
          Number would make it approximately that.
        */
        budgetMinor: ((BigInt(Math.round(amount * 1e6)) * scale) / 1_000_000n).toString(),
      });
      onClose();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="veil" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet">
        <h2>Hire an agent</h2>

        <div className="field">
          <label htmlFor="label">Name</label>
          <input
            id="label"
            value={label}
            placeholder="researcher"
            autoFocus
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="hint">
            {state.naming
              ? `Minted as ${label.trim() ? `${label.trim().toLowerCase()}.` : ''}${state.root} — a real name, which is what makes revoking it work.`
              : 'Names are off on this chain, so this one is local only.'}
          </div>
        </div>

        <div className="field">
          <label htmlFor="brief">What it does</label>
          <textarea
            id="brief"
            value={brief}
            placeholder="Researches a topic and reports back in a short paragraph."
            onChange={(event) => setBrief(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="budget">Budget ({unit})</label>
          <input
            id="budget"
            value={budget}
            inputMode="decimal"
            placeholder={hedera ? '0.5' : '0.05'}
            onChange={(event) => setBudget(event.target.value)}
          />
          <div className="hint">
            The wallet can spend {state.spendable}. An agent cannot exceed this, and cannot raise it.
          </div>
        </div>

        <div className="field">
          <label htmlFor="model">Model</label>
          <select id="model" value={model} onChange={(event) => setModel(event.target.value)}>
            {state.models.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" data-kind="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Minting…' : 'Hire'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------- app */

export const App = () => {
  const { state, connected, log } = useCrew();
  const [selected, setSelected] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);

  const agent = state?.agents.find((candidate) => candidate.id === selected) ?? null;

  useEffect(() => {
    if (!state) return;
    if (!agent && state.agents.length > 0) setSelected(state.agents[0]!.id);
  }, [state, agent]);

  if (!state) {
    return (
      <div className="empty">
        <div className="empty-inner">
          <h3>{connected ? 'Starting…' : 'Waiting for the runtime'}</h3>
          <p style={{ margin: 0, fontSize: 13 }}>
            Run <code style={{ fontFamily: 'var(--mono)' }}>bun run server</code> in <code>apps/crew</code>. It holds
            the wallet; this page never sees it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Rail state={state} selected={selected} onSelect={setSelected} onNew={() => setHiring(true)} log={log} />

      {agent ? (
        <Thread agent={agent} state={state} />
      ) : (
        <div className="thread">
          <div className="empty">
            <div className="empty-inner">
              <h3>No agents yet</h3>
              <p style={{ margin: 0 }}>
                Every agent gets a name under {state.root} and a budget drawn from one wallet. Neither is a label:
                the name is checked before each payment, and the budget is enforced by the side holding the money.
              </p>
              <button className="btn" data-kind="primary" onClick={() => setHiring(true)}>
                Hire the first one
              </button>
            </div>
          </div>
        </div>
      )}

      {agent ? <Detail agent={agent} state={state} /> : <div className="detail" />}

      {hiring ? <HireSheet state={state} onClose={() => setHiring(false)} /> : null}
    </div>
  );
};
