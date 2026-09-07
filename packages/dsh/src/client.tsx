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

export const name = 'llm-edgerouter-settings';
export const inject = ['slots', 'settingsScope'];

const NS = 'llm-edgerouter';

/** The section of settings this page reads. Everything else is ignored. */
type Section = {
  walletAddress?: string;
  walletStatus?: string;
  network?: string;
  wallet?: string;
};

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
    h('h3', { key: 't', style: { margin: '0 0 6px' } }, 'edgerouter'),
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
    h('div', { key: 'card', style: style.card }, [
      h('div', { key: 'st', style: { ...style.row, ...style.label } }, [
        h('span', { key: 'd', style: style.dot(funded) }),
        h('span', { key: 's' }, funded ? 'Ready' : 'Waiting for funds'),
      ]),
      h('div', { key: 'lbl', style: style.label }, `Send ${faucet.asset} to`),
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
          'wallet holding what you chose to put in it — run ' +
          '`npx dsh-plugin-edgerouter sweep <address>` to take it all back out.',
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
        label: () => 'edgerouter',
      },
      () => h(Page, { ctx }),
    ),
  );
}
