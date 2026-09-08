/**
 * An Edge Router tab in the per-conversation sidebar.
 *
 * The settings page can only ever show the latest of anything, because settings
 * are global — one document for the whole install. This surface is not: the
 * sidebar is scoped to a conversation and hands its tabs a `sessionId`, so it
 * can answer the question a settings page cannot, which is "what has *this*
 * chat cost, and what is it called".
 *
 * ## Optional, and quietly so
 *
 * `dsh-better-sidebar` is a third-party plugin that may not be installed. It is
 * reached through `ctx.inject`, which runs the callback only when the service
 * exists, and nothing is imported from it but types — so a profile without it
 * loses this tab and keeps everything else. The settings page remains the
 * surface that always works.
 *
 * ## Where the numbers come from
 *
 * The same settings document as everything else. The Node half keeps a small
 * per-chat ledger and publishes it as JSON keyed by session id; this reads its
 * own row out of that. Nothing is computed here — in particular the chat's name
 * is not derived from the session id, because deriving it means hashing, and
 * hashing means pulling a chain library into a sidebar panel.
 */
import { createElement as h, useSyncExternalStore, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';

const NS = 'llm-edgerouter';

type ChatLedger = { name: string; spentMinor: string; spent: string; calls: number };

type Section = {
  walletAddress?: string;
  walletStatus?: string;
  ensName?: string;
  ensNames?: boolean;
  ensChats?: string;
  delegationUrl?: string;
  delegationStatus?: string;
};

const style = {
  page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px' },
  label: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.55 },
  value: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '12px',
    wordBreak: 'break-all',
    lineHeight: 1.5,
  },
  big: { fontSize: '20px', fontVariantNumeric: 'tabular-nums' },
  note: { margin: 0, fontSize: '12px', opacity: 0.6, lineHeight: 1.5 },
  block: { display: 'flex', flexDirection: 'column', gap: '4px' },
} as const;

/** The wallet icon, drawn rather than imported so the bundle stays react-only. */
const icon = (size: number): ReactNode =>
  h(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
    [
      h('rect', { key: 'r', x: 1.5, y: 3.5, width: 13, height: 9, rx: 2 }),
      h('path', { key: 'p', d: 'M1.5 6.5h13' }),
      h('circle', { key: 'c', cx: 11.5, cy: 9.5, r: 1, fill: 'currentColor', stroke: 'none' }),
    ],
  );

const Panel = ({ ctx, sessionId }: { ctx: Context; sessionId: string }): ReactNode => {
  const scope = ctx.settingsScope.bind<Section>({ namespace: NS });
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );

  const section = snapshot.value ?? {};

  let chat: ChatLedger | undefined;
  try {
    chat = section.ensChats
      ? (JSON.parse(section.ensChats) as Record<string, ChatLedger>)[sessionId]
      : undefined;
  } catch {
    // A ledger that will not parse is one this render does without; the Node
    // half rewrites it on the next payment.
    chat = undefined;
  }

  const rows: ReactNode[] = [];

  rows.push(
    h('div', { key: 'spend', style: style.block }, [
      h('div', { key: 'l', style: style.label }, 'This chat has spent'),
      h('div', { key: 'v', style: style.big }, chat?.spent || 'nothing yet'),
      ...(chat
        ? [h('p', { key: 'n', style: style.note }, `over ${chat.calls} paid call${chat.calls === 1 ? '' : 's'}`)]
        : [
            h(
              'p',
              { key: 'n', style: style.note },
              'Every call through edgerouter is paid for from the wallet, and shows up here.',
            ),
          ]),
    ]),
  );

  /*
    The chat's own name, when it has one. A chat earns a name by paying for
    something — see `nameChat` — so an unnamed chat here is not a failure, it is
    a chat that has not spent anything.
  */
  rows.push(
    h('div', { key: 'name', style: style.block }, [
      h('div', { key: 'l', style: style.label }, 'This chat'),
      chat?.name
        ? h('div', { key: 'v', style: style.value }, chat.name)
        : h(
            'p',
            { key: 'v', style: style.note },
            section.ensNames
              ? 'Named on its first paid call.'
              : 'Chats can claim ENS names — turn it on in Settings → Edge Router.',
          ),
    ]),
  );

  if (section.ensName) {
    rows.push(
      h('div', { key: 'agent', style: style.block }, [
        h('div', { key: 'l', style: style.label }, 'This wallet'),
        h('div', { key: 'v', style: style.value }, section.ensName),
      ]),
    );
  }

  rows.push(
    h('div', { key: 'wallet', style: style.block }, [
      h('div', { key: 'l', style: style.label }, 'Wallet'),
      h('div', { key: 'v', style: style.value }, section.walletAddress ?? 'no wallet yet'),
      h('p', { key: 's', style: style.note }, section.walletStatus ?? ''),
    ]),
  );

  if (section.delegationUrl) {
    rows.push(
      h('div', { key: 'del', style: style.block }, [
        h('div', { key: 'l', style: style.label }, 'Delegation'),
        h('div', { key: 'v', style: style.value }, section.delegationUrl),
        h('p', { key: 's', style: style.note }, section.delegationStatus ?? ''),
      ]),
    );
  }

  return h('div', { style: style.page }, rows);
};

/**
 * Registers the tab, if there is a sidebar to register it with.
 *
 * The service is reached through `inject` rather than depended on, so the
 * plugin still loads for anyone who has not installed the sidebar — they lose a
 * panel, not a provider.
 */
export const registerSidebarTab = (ctx: Context): void => {
  const injectable = ctx as unknown as {
    inject(services: string[], run: (scoped: unknown) => void): void;
  };

  injectable.inject(['betterSidebar'], (scoped) => {
    const service = (scoped as { betterSidebar: {
      registerTab(descriptor: {
        id: string;
        title: string | (() => string);
        icon?: ReactNode | ((size: number) => ReactNode);
        order?: number;
        single?: boolean;
        component: (props: { ctx: Context; scope: { sessionId: string } }) => ReactNode;
      }): () => void;
    } }).betterSidebar;

    service.registerTab({
      id: 'edgerouter:spend',
      title: () => 'Edge Router',
      icon,
      // After the shipped tabs. A plugin claiming a low number is claiming to
      // matter more than the tools the user opened the sidebar for.
      order: 120,
      single: true,
      /*
        This plugin's own context, not the one the tab is handed.

        Cordis gates service access per context: a context may only read
        services it declared in `inject`. The sidebar hands its tabs *its*
        context, which never asked for `settingsScope`, so reading settings
        through it throws — "cannot get property settingsScope without inject",
        rendered in place of the panel. The context that did ask for it is the
        one this plugin was applied with, and it is in scope here.
      */
      component: ({ scope }) => h(Panel, { ctx, sessionId: scope.sessionId }),
    });
  });
};
