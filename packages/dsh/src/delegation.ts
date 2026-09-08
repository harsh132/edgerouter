/**
 * Delegation, run by the plugin rather than by a terminal.
 *
 * The budget authority already existed and already worked; what it did not have
 * was anywhere to live. Running it meant a second process, two environment
 * variables, and a root capability printed to stdout — which is why delegation
 * has been the half of this project nobody could see.
 *
 * So it runs here, inside DSH, signed by the wallet the user already funded.
 *
 * ## What the root capability is, and why it never leaves
 *
 * Whoever holds the root capability holds the whole budget. It is created in
 * memory and stays there: the settings page can ask for allowances to be minted
 * and revoked, but it is never handed the token that would let it do those
 * things itself. Child capabilities are shown once, because a sub-agent has to
 * be given one somehow, and they are bounded by construction — a child spends
 * its own node and nothing else.
 *
 * ## Why the tree is rebuilt on every restart
 *
 * The authority's state is in memory, so restarting DSH empties it. That is a
 * real limitation and it is stated rather than hidden: allowances are for a
 * session. A capability minted before a restart verifies fine and then finds no
 * node to spend, which the authority reports as `unknown_node` — the same
 * answer a revoked capability gets, which is the honest one, because from the
 * holder's side those situations are identical.
 */
import {
  createAuthority,
  authorityHandler,
  serveAuthority,
  formatAmount,
  type Authority,
  type NameGuard,
  type PaymentSigner,
  type ServedAuthority,
} from '../../sdk/src/index';

/** What the settings page is shown about one allowance. */
export type AllowanceView = {
  id: string;
  parent: string | null;
  depth: number;
  balanceMinor: string;
  /** Rendered here rather than in the browser: the network lives on this side. */
  balance: string;
};

export type DelegationState = {
  running: boolean;
  url: string;
  status: string;
  allowances: AllowanceView[];
};

export type DelegationOptions = {
  signer: PaymentSigner;
  network: string;
  /** What the root node starts with, in the asset's smallest unit. */
  fundedMinor: bigint;
  /** Names each allowance is checked against before it may spend. */
  names?: NameGuard;
  port?: number;
  log?: (line: string) => void;
};

export type Delegation = {
  readonly url: string;
  /** The tree as the settings page should see it. */
  view(): DelegationState;
  /**
   * Creates an allowance and returns its capability — the only time it exists
   * outside this process.
   */
  mint(params: { child: string; amountMinor: bigint; hours: number }): Promise<string>;
  revoke(node: string): Promise<bigint>;
  stop(): Promise<void>;
};

/**
 * A secret that lasts exactly as long as the tree it signs for.
 *
 * Generated rather than configured, and deliberately not persisted. A stored
 * secret would let capabilities outlive the balances they spend, so a token
 * from a previous run would verify and then fail on a missing node — the same
 * outcome, reached more confusingly. Regenerating makes the failure immediate
 * and its reason obvious.
 */
const sessionSecret = (): string => `${crypto.randomUUID()}${crypto.randomUUID()}`;

const ROOT_NODE = 'root';

export const startDelegation = async (options: DelegationOptions): Promise<Delegation> => {
  const log = options.log ?? (() => {});

  const authority: Authority = await createAuthority({
    signer: options.signer,
    secret: sessionSecret(),
    fundedMinor: options.fundedMinor,
    ...(options.names ? { names: options.names } : {}),
  });

  const served: ServedAuthority = await serveAuthority(authorityHandler(authority), {
    ...(options.port ? { port: options.port } : {}),
  });
  log(`llm-edgerouter: delegation listening on ${served.url}`);

  const view = (): DelegationState => ({
    running: true,
    url: served.url,
    status: `holding ${formatAmount(options.network, options.fundedMinor)} for delegation`,
    allowances: authority.balances(ROOT_NODE).map((node) => ({
      id: node.id,
      parent: node.parent,
      depth: node.depth,
      balanceMinor: node.balanceMinor.toString(),
      balance: formatAmount(options.network, node.balanceMinor),
    })),
  });

  return {
    url: served.url,
    view,

    async mint({ child, amountMinor, hours }) {
      const granted = await authority.mint({
        // Minted from the root token, which is held here and nowhere else.
        parent: authority.rootToken,
        child,
        amountMinor,
        expiresAt: Date.now() + hours * 60 * 60 * 1000,
      });
      log(
        `llm-edgerouter: delegated ${formatAmount(options.network, amountMinor)} to ${child}`,
      );
      return granted.capability;
    },

    async revoke(node) {
      const { recoveredMinor } = authority.revoke({ token: authority.rootToken, node });
      log(
        `llm-edgerouter: revoked ${node}, recovering ${formatAmount(options.network, recoveredMinor)}`,
      );
      return recoveredMinor;
    },

    stop: () => served.close(),
  };
};
