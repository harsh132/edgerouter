/**
 * The browser half: an `edgerouter` page in Desktop's Settings.
 *
 * Why this exists at all. The Models pane renders a provider's settings section
 * as an endpoint-and-key profile — it looks for the fields an API-key provider
 * has, finds none of ours, and prints "other fields live in settings.yaml".
 * That is a reasonable default and a bad first run: the one thing a new user
 * needs is an address to send money to, and it was reachable only by opening a
 * YAML file.
 *
 * So the plugin owns a settings page. `settings.section` is a list slot, and a
 * registrant supplies the nav identity (`id`, `order`, `label`) and the page.
 *
 * ## Where the data comes from
 *
 * Not from an RPC of our own. The Node half already writes `walletAddress` and
 * `walletStatus` into this plugin's settings namespace, and the browser can
 * read that namespace through `ctx.settingsScope` — the same document, one
 * shared mirror, refreshed on every commit. So the page is a view over settings
 * rather than a second source of truth that could disagree with the first.
 *
 * ## No JSX
 *
 * `createElement` directly, so the bundle requests `react` and nothing else.
 * JSX would add `react/jsx-runtime` to the module requests for no gain in a
 * file this size, and every request has to be answered by the shell's frozen
 * module table.
 */
import { createElement as h, useSyncExternalStore, useState, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-runtime/client';
import { registerSidebarTab } from './sidebar';

export const name = 'llm-edgerouter-settings';
export const inject = ['slots', 'settingsScope'];

const NS = 'llm-edgerouter';

/** The section of settings this page reads. Everything else is ignored. */
type Section = {
  walletAddress?: string;
  walletStatus?: string;
  network?: string;
  wallet?: string;
  /**
   * A command, not a setting: the address the Node half should send everything
   * to. Set by the button below, cleared by the Node half once it has taken the
   * instruction. Non-empty therefore means "a withdrawal is in flight", which
   * is what disables the button.
   */
  withdrawTo?: string;
  /** Reported by the Node half: how the last withdrawal went. */
  withdrawStatus?: string;
  /** Whether this session claims an ENS name. Costs gas the first time. */
  ensNames?: boolean;
  /** Reported by the Node half: this session's name. */
  ensName?: string;
  /** Reported by the Node half: what the naming attempt did. */
  ensStatus?: string;
  /** Reported by the Node half: the most recent chat to be named. */
  ensChatName?: string;
  ensChatStatus?: string;

  /** A command: USDC to deposit into Circle's Gateway. Cleared by the Node half. */
  depositAmount?: string;

  delegation?: boolean;
  delegationUrl?: string;
  delegationStatus?: string;
  /** The allowance tree as JSON, rendered by the Node half. */
  delegationTree?: string;
  delegateMint?: string;
  delegateRevoke?: string;
  /** Shown once, then cleared by the Node half. */
  delegateCapability?: string;
};

type Allowance = {
  id: string;
  parent: string | null;
  depth: number;
  balanceMinor: string;
  balance: string;
};

/**
 * What a withdrawal destination looks like on this network.
 *
 * Checked here so a typo is caught before it becomes a transfer, and checked
 * again in the Node half because this half is a convenience and the other one
 * holds the key.
 */
const destination = (network: string | undefined) =>
  (network ?? 'hedera:testnet').startsWith('eip155')
    ? {
        placeholder: '0x…',
        hint: 'A wallet address on this chain.',
        valid: (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value),
      }
    : {
        placeholder: '0.0.1234',
        hint: 'A Hedera account id — not an EVM address.',
        valid: (value: string) => /^\d+\.\d+\.\d+$/.test(value),
      };

/**
 * The chains this plugin can pay on.
 *
 * Listed rather than discovered, because there is nothing to discover from: a
 * 402 quotes one network, and the gate has no endpoint that enumerates the
 * rest. So this is a claim about what the *plugin* can sign for, which is the
 * honest framing anyway — a chain the gate accepts and this plugin cannot sign
 * is not a chain the user can pick.
 *
 * `settles` names the facilitator because it is the part people do not expect.
 * The same wallet pays on all three, and three different services move the
 * money; that is the design, and it is invisible unless said.
 */
const NETWORKS: { id: string; label: string; asset: string; settles: string }[] = [
  { id: 'hedera:testnet', label: 'Hedera testnet', asset: 'HBAR', settles: 'Blocky402' },
  { id: 'eip155:84532', label: 'Base Sepolia', asset: 'USDC', settles: 'x402.org' },
  { id: 'eip155:5042002', label: 'Arc testnet', asset: 'USDC', settles: 'Circle Gateway' },
];

/**
 * Picks the chain to pay on.
 *
 * A real switch, not a display: changing it tears down the payment source and
 * builds a new one, because a wallet, a poll and possibly a connection to
 * another process cannot be re-pointed at a different chain. The funding state
 * changes with it — the same key is funded differently on each — which is why
 * this sits directly above the address rather than in a corner.
 */
const NetworkPicker = ({
  scope,
  current,
}: {
  scope: { set(field: string, value: unknown): Promise<void> };
  current: string;
}): ReactNode =>
  h('div', { style: style.card }, [
    h('div', { key: 'l', style: style.label }, 'Paying on'),
    h(
      'div',
      { key: 'r', style: style.row },
      NETWORKS.map((network) => {
        const active = network.id === current;
        return h(
          'button',
          {
            key: network.id,
            type: 'button',
            style: active
              ? { ...style.button, borderColor: '#3fb950', color: '#3fb950' }
              : style.button,
            onClick: () => {
              if (!active) void scope.set('network', network.id);
            },
          },
          network.label,
        );
      }),
    ),
    h(
      'p',
      { key: 'n', style: style.note },
      (() => {
        const chosen = NETWORKS.find((network) => network.id === current);
        return chosen
          ? `Paying in ${chosen.asset}, settled through ${chosen.settles}. ` +
              'The same wallet pays on every one of these.'
          : `Configured for ${current}, which this page does not know about.`;
      })(),
    ),
  ]);

const FAUCETS: Record<string, { label: string; url: string; asset: string }> = {
  hedera: { label: 'Hedera portal faucet', url: 'https://portal.hedera.com/faucet', asset: 'testnet HBAR' },
  eip155: { label: "Circle's faucet", url: 'https://faucet.circle.com', asset: 'testnet USDC' },
};

const faucetFor = (network: string | undefined) =>
  FAUCETS[(network ?? 'hedera:testnet').split(':')[0] ?? 'hedera'] ?? FAUCETS.hedera!;

const style = {
  page: { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '640px' },
  lead: { margin: 0, opacity: 0.75, lineHeight: 1.5 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.25)',
  },
  label: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6 },
  address: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '14px',
    wordBreak: 'break-all',
    lineHeight: 1.5,
  },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  button: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  note: { margin: 0, fontSize: '13px', opacity: 0.65, lineHeight: 1.5 },
  input: {
    flex: '1 1 260px',
    minWidth: 0,
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '13px',
  },
  /*
    The confirm button is the one control here that moves money, so it is the
    one control here that does not look like the others.
  */
  danger: {
    padding: '6px 12px',
    borderRadius: '6px',
    border: '1px solid #d2493a',
    background: 'transparent',
    color: '#e5534b',
    cursor: 'pointer',
    font: 'inherit',
  },
  disabled: { opacity: 0.45, cursor: 'default' },
  dot: (ok: boolean) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: ok ? '#3fb950' : '#d29922',
    flex: '0 0 auto',
  }),
} as const;

/** Copies to the clipboard and says so, because a silent button looks broken. */
const CopyButton = ({ value }: { value: string }): ReactNode => {
  const [copied, setCopied] = useState(false);
  return h(
    'button',
    {
      type: 'button',
      style: style.button,
      onClick: () => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setCopied(false));
      },
    },
    copied ? 'Copied' : 'Copy address',
  );
};

/**
 * Sends everything in the wallet somewhere else.
 *
 * Two deliberate frictions, because this is the only irreversible thing on the
 * page. It is closed until asked for, so it cannot be hit while aiming at
 * "Copy address"; and the confirm stays disabled until the destination parses
 * for this network, so the common way to lose testnet funds — an EVM address
 * pasted into a Hedera transfer — is refused before it is signed.
 *
 * The button does not perform the withdrawal. It writes the destination into
 * settings and the Node half, which is the only half holding a key, does the
 * rest and reports back through `withdrawStatus`.
 */
const Withdraw = ({
  scope,
  network,
  pending,
  result,
}: {
  scope: { set(field: string, value: unknown): Promise<void> };
  network: string | undefined;
  pending: boolean;
  result: string;
}): ReactNode => {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const spec = destination(network);
  const ready = spec.valid(to.trim()) && !pending;

  if (!open) {
    return h('div', { style: { ...style.card, gap: '8px' } }, [
      h('div', { key: 'l', style: style.label }, 'Withdraw'),
      h(
        'p',
        { key: 'n', style: style.note },
        'Moves the whole balance out of this wallet. Nothing is kept back except, ' +
          'on Hedera, a small reserve for the transfer’s own fee.',
      ),
      h(
        'div',
        { key: 'r', style: style.row },
        [
          h(
            'button',
            { key: 'b', type: 'button', style: style.button, onClick: () => setOpen(true) },
            'Withdraw…',
          ),
          ...(result ? [h('span', { key: 's', style: style.note }, result)] : []),
        ],
      ),
    ]);
  }

  return h('div', { style: { ...style.card, gap: '10px' } }, [
    h('div', { key: 'l', style: style.label }, 'Withdraw everything'),
    h('p', { key: 'h', style: style.note }, spec.hint),
    h('div', { key: 'r', style: style.row }, [
      h('input', {
        key: 'i',
        style: style.input,
        value: to,
        placeholder: spec.placeholder,
        spellCheck: false,
        autoComplete: 'off',
        disabled: pending,
        onChange: (event: { target: { value: string } }) => setTo(event.target.value),
      }),
      h(
        'button',
        {
          key: 'go',
          type: 'button',
          disabled: !ready,
          style: ready ? style.danger : { ...style.danger, ...style.disabled },
          onClick: () => {
            /*
              Fire and forget. A rejected write leaves the field unset, so the
              withdrawal simply does not happen — there is no half-done state to
              unwind, and the Node half never saw an instruction.
            */
            void scope.set('withdrawTo', to.trim());
            setTo('');
          },
        },
        pending ? 'Sending…' : 'Send everything',
      ),
      h(
        'button',
        {
          key: 'x',
          type: 'button',
          style: style.button,
          onClick: () => {
            setOpen(false);
            setTo('');
          },
        },
        'Cancel',
      ),
    ]),
    ...(result ? [h('p', { key: 's', style: style.note }, result)] : []),
  ]);
};

/**
 * The names this install answers to.
 *
 * Two of them, and the distinction is the one thing this card has to get right,
 * because an earlier version called the first a "session name" and sent a user
 * looking for it beside a chat that did not have one:
 *
 *   the wallet's name   one per install, claimed once. This is the agent.
 *   a chat's name       one per chat, minted the first time that chat pays.
 *
 * Chats are named on first payment rather than on first message, because
 * naming costs gas and a chat that has bought nothing is not an actor. Only the
 * most recent one is shown — settings are global, and a per-chat panel would
 * need a per-chat place to live.
 *
 * The whole thing is off until asked, because the first mint spends real money.
 */
const Naming = ({
  scope,
  enabled,
  name,
  status,
  chatName,
  chatStatus,
}: {
  scope: { set(field: string, value: unknown): Promise<void> };
  enabled: boolean;
  name: string;
  status: string;
  chatName: string;
  chatStatus: string;
}): ReactNode =>
  h('div', { style: style.card }, [
    h('div', { key: 'l', style: style.label }, 'Name'),
    ...(name
      ? [
          h('div', { key: 'nl', style: style.note }, 'This wallet'),
          h('div', { key: 'n', style: style.address }, name),
          h('p', { key: 's', style: style.note }, status),
          ...(chatName
            ? [
                h('div', { key: 'cl', style: { ...style.note, marginTop: '6px' } }, 'Most recent chat'),
                h('div', { key: 'c', style: style.address }, chatName),
                h('p', { key: 'cs', style: style.note }, chatStatus),
              ]
            : [
                h(
                  'p',
                  { key: 'cn', style: style.note },
                  'Chats are named the first time they pay for something, so an ' +
                    'unused chat costs no gas.',
                ),
              ]),
        ]
      : [
          h(
            'p',
            { key: 'n', style: style.note },
            enabled
              ? status || 'Claiming a name…'
              : 'This wallet can claim an ENS name, which is what the budget authority ' +
                  'checks before it signs a payment. Sub-agents get names beneath it, so ' +
                  'revoking one stops everything under it too.',
          ),
        ]),
    h(
      'div',
      { key: 'r', style: style.row },
      [
        h(
          'button',
          {
            key: 'b',
            type: 'button',
            style: style.button,
            onClick: () => void scope.set('ensNames', !enabled),
          },
          enabled ? 'Stop claiming names' : 'Claim a name',
        ),
        ...(enabled && !name
          ? [h('span', { key: 'g', style: style.note }, 'Needs Sepolia ETH for gas.')]
          : []),
      ],
    ),
  ]);

/**
 * Moving money into Circle's Gateway.
 *
 * Only rendered on a network that pays that way, because everywhere else there
 * is nothing to deposit into and the control would be a question with no
 * meaning.
 *
 * It is the one piece of setup this project cannot make disappear. Elsewhere
 * funding an address is the whole story; here paying draws on a balance held by
 * the GatewayWallet contract, so an address holding twenty USDC and nothing
 * deposited can pay for exactly nothing — which is worth saying plainly rather
 * than leaving to be discovered through a refusal.
 */
const Deposit = ({
  scope,
  pending,
  status,
}: {
  scope: { set(field: string, value: unknown): Promise<void> };
  pending: boolean;
  status: string;
}): ReactNode => {
  const [amount, setAmount] = useState('0.5');
  const ready = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0 && !pending;

  return h('div', { style: style.card }, [
    h('div', { key: 'l', style: style.label }, 'Gateway balance'),
    h(
      'p',
      { key: 'n', style: style.note },
      'This network pays through Circle Gateway, which draws on a balance you ' +
        'deposit rather than on the address itself. Fund the address first, then ' +
        'deposit — payment comes out of the deposit.',
    ),
    h('div', { key: 'r', style: style.row }, [
      h('input', {
        key: 'a',
        style: { ...style.input, flex: '0 1 120px' },
        value: amount,
        placeholder: '0.5',
        spellCheck: false,
        disabled: pending,
        onChange: (event: { target: { value: string } }) => setAmount(event.target.value),
      }),
      h(
        'button',
        {
          key: 'go',
          type: 'button',
          disabled: !ready,
          style: ready ? style.button : { ...style.button, ...style.disabled },
          onClick: () => void scope.set('depositAmount', amount),
        },
        pending ? 'Depositing…' : 'Deposit USDC',
      ),
      h(
        'a',
        {
          key: 'f',
          href: 'https://faucet.circle.com',
          target: '_blank',
          rel: 'noreferrer',
          style: style.button,
        },
        'Circle faucet',
      ),
    ]),
    ...(status ? [h('p', { key: 's', style: style.note }, status)] : []),
  ]);
};

/**
 * Allowances handed to sub-agents.
 *
 * The half of this project that has been real for weeks and invisible the whole
 * time: a budget authority signs payments for sub-agents against allowances
 * that cannot be widened, and until now the only way to see one was a terminal.
 *
 * Nothing here holds a key or a capability. The page writes commands into
 * settings and the Node half — which owns the authority, the root capability
 * and the wallet — carries them out and reports back. The one exception is a
 * freshly minted capability, which is shown once because a sub-agent has to be
 * handed it somehow, and then wiped.
 */
const Delegation = ({
  scope,
  enabled,
  url,
  status,
  tree,
  capability,
}: {
  scope: { set(field: string, value: unknown): Promise<void> };
  enabled: boolean;
  url: string;
  status: string;
  tree: string;
  capability: string;
}): ReactNode => {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('24');

  let allowances: Allowance[] = [];
  try {
    allowances = tree ? ((JSON.parse(tree) as { allowances: Allowance[] }).allowances ?? []) : [];
  } catch {
    /*
      A tree that will not parse is a tree that is not shown. The Node half
      rewrites it on every change, so the next report repairs this rather than
      leaving the page stuck on a parse error.
    */
    allowances = [];
  }

  const ready = /^[a-z0-9][a-z0-9-]{0,30}$/.test(label) && /^[0-9]+$/.test(amount) && Number(amount) > 0;

  if (!enabled) {
    return h('div', { style: style.card }, [
      h('div', { key: 'l', style: style.label }, 'Delegation'),
      h(
        'p',
        { key: 'n', style: style.note },
        'Hand a sub-agent an allowance instead of a key. It spends against a budget ' +
          'it cannot widen, you can take it back at any time, and it never sees the ' +
          'wallet. Runs on loopback, for agents on this machine.',
      ),
      h(
        'div',
        { key: 'r', style: style.row },
        h(
          'button',
          { type: 'button', style: style.button, onClick: () => void scope.set('delegation', true) },
          'Turn on delegation',
        ),
      ),
    ]);
  }

  return h('div', { style: style.card }, [
    h('div', { key: 'l', style: { ...style.row, ...style.label } }, [
      h('span', { key: 'd', style: style.dot(Boolean(url)) }),
      h('span', { key: 't' }, 'Delegation'),
    ]),
    h('p', { key: 's', style: style.note }, status || 'starting…'),
    ...(url
      ? [
          h('div', { key: 'u', style: style.label }, 'Sub-agents point at'),
          h('div', { key: 'ua', style: style.address }, url),
        ]
      : []),

    /*
      Shown once. The Node half clears the field after this render, so a
      capability nobody copied has to be minted again — the correct trade for a
      bearer token.
    */
    ...(capability
      ? [
          h('div', { key: 'ck', style: { ...style.card, borderColor: '#d2493a' } }, [
            h('div', { key: 'l', style: style.label }, 'Capability — shown once'),
            h('div', { key: 'v', style: style.address }, capability),
            h('div', { key: 'r', style: style.row }, [
              h(CopyButton, { key: 'c', value: capability }),
              h(
                'button',
                {
                  key: 'x',
                  type: 'button',
                  style: style.button,
                  onClick: () => void scope.set('delegateCapability', ''),
                },
                'Done',
              ),
            ]),
            h(
              'p',
              { key: 'n', style: style.note },
              'Give this to the sub-agent as EDGEROUTER_CAPABILITY. Anyone holding it ' +
                'can spend that allowance and nothing else.',
            ),
          ]),
        ]
      : []),

    ...(allowances.length
      ? [
          h('div', { key: 'ln', style: style.label }, 'Allowances'),
          ...allowances.map((node) =>
            h('div', { key: node.id, style: { ...style.row, justifyContent: 'space-between' } }, [
              h(
                'span',
                { key: 'n', style: { ...style.address, flex: '1 1 auto' } },
                `${'\u00a0\u00a0'.repeat(node.depth)}${node.id}`,
              ),
              h('span', { key: 'b', style: style.note }, node.balance),
              ...(node.parent === null
                ? []
                : [
                    h(
                      'button',
                      {
                        key: 'r',
                        type: 'button',
                        style: style.button,
                        onClick: () => void scope.set('delegateRevoke', node.id),
                      },
                      'Revoke',
                    ),
                  ]),
            ]),
          ),
        ]
      : []),

    h('div', { key: 'mk', style: style.label }, 'New allowance'),
    h('div', { key: 'mf', style: style.row }, [
      h('input', {
        key: 'l',
        style: { ...style.input, flex: '1 1 120px' },
        value: label,
        placeholder: 'researcher',
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => setLabel(event.target.value),
      }),
      h('input', {
        key: 'a',
        style: { ...style.input, flex: '1 1 140px' },
        value: amount,
        placeholder: 'amount (smallest unit)',
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => setAmount(event.target.value),
      }),
      h('input', {
        key: 'h',
        style: { ...style.input, flex: '0 1 80px' },
        value: hours,
        placeholder: 'hours',
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => setHours(event.target.value),
      }),
      h(
        'button',
        {
          key: 'go',
          type: 'button',
          disabled: !ready,
          style: ready ? style.button : { ...style.button, ...style.disabled },
          onClick: () => {
            void scope.set('delegateMint', `${label}|${amount}|${hours || '24'}`);
            setLabel('');
            setAmount('');
          },
        },
        'Delegate',
      ),
    ]),
    h(
      'p',
      { key: 'off', style: style.note },
      'Amounts are in the smallest unit — 100000000 is one hbar.',
    ),
    h(
      'div',
      { key: 'stop', style: style.row },
      h(
        'button',
        { type: 'button', style: style.button, onClick: () => void scope.set('delegation', false) },
        'Turn off delegation',
      ),
    ),
  ]);
};

const Page = ({ ctx }: { ctx: Context }): ReactNode => {
  const scope = ctx.settingsScope.bind<Section>({ namespace: NS });
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );

  const section = snapshot.value ?? {};
  const address = section.walletAddress;
  const status = section.walletStatus ?? '';
  const funded = status.startsWith('ready');
  const faucet = faucetFor(section.network);

  const heading = h('div', { key: 'h' }, [
    h('h3', { key: 't', style: { margin: '0 0 6px' } }, 'Edge Router'),
    h(
      'p',
      { key: 'p', style: style.lead },
      'This provider pays for each call with a wallet instead of an API key. ' +
        'There is no account and nothing to sign up for — the only setup is putting ' +
        'money in the wallet below.',
    ),
  ]);

  /*
    Three states, and the loading one matters: the settings document arrives
    asynchronously, and a page that renders "no wallet" for a moment before the
    address appears reads as a broken install.
  */
  if (snapshot.status === 'loading') {
    return h('div', { style: style.page }, [heading, h('p', { key: 'w', style: style.note }, 'Loading…')]);
  }

  if (!address) {
    return h('div', { style: style.page }, [
      heading,
      h('div', { key: 'c', style: style.card }, [
        h('div', { key: 'l', style: style.label }, 'No wallet yet'),
        h(
          'p',
          { key: 'n', style: style.note },
          'The plugin generates one the first time it starts. If this persists, ' +
            'the provider may not have loaded — check the log for llm-edgerouter.',
        ),
      ]),
    ]);
  }

  return h('div', { style: style.page }, [
    heading,
    h(NetworkPicker, { key: 'picker', scope, current: section.network ?? 'hedera:testnet' }),
    h('div', { key: 'card', style: style.card }, [
      h('div', { key: 'st', style: { ...style.row, ...style.label } }, [
        h('span', { key: 'd', style: style.dot(funded) }),
        h('span', { key: 's' }, funded ? 'Ready' : 'Waiting for funds'),
      ]),
      /*
        The same address, described by what the reader still has to do with it.
        Before funding it is an instruction; after funding it is just the
        wallet's name, and leaving the instruction up reads as though the setup
        never took.
      */
      h('div', { key: 'lbl', style: style.label }, funded ? 'Wallet address' : `Send ${faucet.asset} to`),
      h('div', { key: 'addr', style: style.address }, address),
      h('div', { key: 'row', style: style.row }, [
        h(CopyButton, { key: 'copy', value: address }),
        h(
          'a',
          { key: 'faucet', href: faucet.url, target: '_blank', rel: 'noreferrer', style: style.button },
          faucet.label,
        ),
      ]),
      h('p', { key: 'status', style: style.note }, status),
    ]),

    /*
      Gateway networks only. The list is short and explicit rather than derived,
      because "Circle supports this chain" and "our gate quotes it through
      Gateway" are different claims — Base is the former and not the latter.
    */
    ...(section.network === 'eip155:5042002'
      ? [
          h(Deposit, {
            key: 'deposit',
            scope,
            pending: Boolean(section.depositAmount),
            status,
          }),
        ]
      : []),

    h(Delegation, {
      key: 'delegation',
      scope,
      enabled: Boolean(section.delegation),
      url: section.delegationUrl ?? '',
      status: section.delegationStatus ?? '',
      tree: section.delegationTree ?? '',
      capability: section.delegateCapability ?? '',
    }),

    h(Naming, {
      key: 'naming',
      scope,
      enabled: Boolean(section.ensNames),
      name: section.ensName ?? '',
      status: section.ensStatus ?? '',
      chatName: section.ensChatName ?? '',
      chatStatus: section.ensChatStatus ?? '',
    }),

    /*
      Only once there is something to withdraw. An unfunded wallet has a balance
      of zero and the offer would be noise on the one screen where the reader is
      trying to do the opposite.
    */
    ...(funded
      ? [
          h(Withdraw, {
            key: 'withdraw',
            scope,
            network: section.network,
            pending: Boolean(section.withdrawTo),
            result: section.withdrawStatus ?? '',
          }),
        ]
      : []),

    h('div', { key: 'notes', style: style.card }, [
      h('div', { key: 'l', style: style.label }, 'Worth knowing'),
      h(
        'p',
        { key: 'a', style: style.note },
        section.network?.startsWith('eip155')
          ? 'Paying costs no gas — the facilitator submits and pays for the transfer. ' +
              'Only moving funds back out needs the chain’s own token.'
          : 'The account is created by the first transfer to this address. There is ' +
              'nothing to register, and no fee to pay before you can receive.',
      ),
      h(
        'p',
        { key: 'b', style: style.note },
        'The key lives in ~/.edgerouter and is not encrypted. Treat this as a hot ' +
          'wallet holding what you chose to put in it — Withdraw above takes it all ' +
          'back out, as does `npx dsh-plugin-edgerouter sweep <address>`.',
      ),
      h(
        'p',
        { key: 'c', style: style.note },
        'Every paid call is logged with its price and settlement id. A provider that ' +
          'spends money invisibly is not one anybody should install.',
      ),
    ]),
  ]);
};

export function apply(ctx: Context): void {
  /*
    A second surface, and the only one that knows which conversation is being
    looked at. Optional: it registers itself only if the sidebar plugin is
    installed, and the settings page below is what always works.
  */
  registerSidebarTab(ctx);

  /*
    `inject` on the slot rather than a hard dependency: the settings shell is
    one composition among several, and a profile without it should lose this
    page rather than fail to boot.
  */
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'edgerouter',
        // After the shipped sections, before nothing in particular. A plugin
        // claiming a low number is claiming to matter more than the shell.
        order: 60,
        label: () => 'Edge Router',
      },
      () => h(Page, { ctx }),
    ),
  );
}
