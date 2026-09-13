/**
 * The budget tree: funding, sweeping, and conservation.
 *
 * The capability token says what a node is *allowed* to spend. This says what
 * it *has*. Both exist because they fail differently: a token can be stolen but
 * cannot be widened, and a balance can be spent but cannot be exceeded.
 *
 * Three of the six original invariants live here and are not enforced by any
 * check, because they are arithmetic:
 *
 *   a child's budget ⊆ its parent's   — you can only fund from what you hold
 *   a child spending spends its parent — the money already left the parent
 *   no node raises its own limit       — it cannot mint currency
 *
 * The only rules this file actually enforces are the two that arithmetic does
 * not give for free: depth bounds, and the direction of revocation.
 *
 * This is an in-memory model of state that really lives in wallet balances on
 * chain. It exists so the rules can be property-tested without a network, and
 * so the SDK has one place to reason about a tree before it moves real money.
 */

export type NodeId = string;

export type Node = {
  id: NodeId;
  parent: NodeId | null;
  /** Currently held, in the smallest currency unit. Never negative. */
  balanceMinor: bigint;
  /** Distance from the root. The root is 0. */
  depth: number;
};

export type Tree = {
  root: NodeId;
  nodes: ReadonlyMap<NodeId, Node>;
};

export type TreeError =
  | { code: 'unknown_node'; id: NodeId }
  | { code: 'duplicate_node'; id: NodeId }
  | { code: 'insufficient_funds'; have: bigint; want: bigint }
  | { code: 'depth_exceeded'; max: number }
  | { code: 'not_an_ancestor'; of: NodeId }
  | { code: 'negative_amount' };

export type Result<T> = { ok: true; value: T } | { ok: false; error: TreeError };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: TreeError): Result<T> => ({ ok: false, error });

export const createTree = (root: NodeId, fundedMinor: bigint): Tree => ({
  root,
  nodes: new Map([[root, { id: root, parent: null, balanceMinor: fundedMinor, depth: 0 }]]),
});

const withNodes = (tree: Tree, updates: readonly Node[]): Tree => {
  const nodes = new Map(tree.nodes);
  for (const node of updates) nodes.set(node.id, node);
  return { ...tree, nodes };
};

/**
 * Creates a child and moves money into it in one step.
 *
 * Deliberately not two operations. A `createChild` that leaves a node at zero,
 * followed by a separate `fund`, produces a window in which a node exists with
 * no allocation — and every caller would then have to remember to close it.
 * Delegation is a transfer; modelling it as one removes the window.
 */
export const delegate = (
  tree: Tree,
  params: { parent: NodeId; child: NodeId; amountMinor: bigint; maxDepth?: number },
): Result<Tree> => {
  if (params.amountMinor < 0n) return err({ code: 'negative_amount' });

  const parent = tree.nodes.get(params.parent);
  if (!parent) return err({ code: 'unknown_node', id: params.parent });
  if (tree.nodes.has(params.child)) return err({ code: 'duplicate_node', id: params.child });

  if (parent.balanceMinor < params.amountMinor) {
    return err({ code: 'insufficient_funds', have: parent.balanceMinor, want: params.amountMinor });
  }

  const depth = parent.depth + 1;
  if (params.maxDepth !== undefined && depth > params.maxDepth) {
    return err({ code: 'depth_exceeded', max: params.maxDepth });
  }

  return ok(
    withNodes(tree, [
      { ...parent, balanceMinor: parent.balanceMinor - params.amountMinor },
      { id: params.child, parent: parent.id, balanceMinor: params.amountMinor, depth },
    ]),
  );
};

/** Everything below `id`, deepest first, so a caller can sweep leaves upward. */
export const subtree = (tree: Tree, id: NodeId): readonly Node[] => {
  const children = new Map<NodeId, Node[]>();
  for (const node of tree.nodes.values()) {
    if (node.parent === null) continue;
    const list = children.get(node.parent);
    if (list) list.push(node);
    else children.set(node.parent, [node]);
  }

  const out: Node[] = [];
  const walk = (current: NodeId) => {
    for (const child of children.get(current) ?? []) {
      walk(child.id);
      out.push(child);
    }
  };
  walk(id);
  return out;
};

/**
 * Revocation: empty a node and everything beneath it, returning the money.
 *
 * This *is* revocation. There is no revocation list, because the service that
 * verifies capabilities keeps no state to hold one — see `token.ts`. A token
 * over an empty balance is harmless, which makes sweeping both the enforcement
 * and the remedy, and makes it immediate rather than eventually-consistent.
 *
 * Funds return to the revoked node's parent rather than to the root. The parent
 * granted the allocation, so the parent gets it back; sending it to the root
 * would quietly move money between siblings' ancestors.
 */
export const revoke = (tree: Tree, id: NodeId): Result<Tree> => {
  const node = tree.nodes.get(id);
  if (!node) return err({ code: 'unknown_node', id });
  if (node.parent === null) return err({ code: 'not_an_ancestor', of: id });

  const parent = tree.nodes.get(node.parent);
  if (!parent) return err({ code: 'unknown_node', id: node.parent });

  const doomed = [...subtree(tree, id), node];
  const recovered = doomed.reduce((sum, n) => sum + n.balanceMinor, 0n);

  const nodes = new Map(tree.nodes);
  for (const n of doomed) nodes.delete(n.id);
  nodes.set(parent.id, { ...parent, balanceMinor: parent.balanceMinor + recovered });

  return ok({ ...tree, nodes });
};

/** Records a spend. The only operation that removes money from the tree. */
export const spend = (
  tree: Tree,
  params: { node: NodeId; amountMinor: bigint },
): Result<Tree> => {
  if (params.amountMinor < 0n) return err({ code: 'negative_amount' });

  const node = tree.nodes.get(params.node);
  if (!node) return err({ code: 'unknown_node', id: params.node });
  if (node.balanceMinor < params.amountMinor) {
    return err({ code: 'insufficient_funds', have: node.balanceMinor, want: params.amountMinor });
  }

  return ok(withNodes(tree, [{ ...node, balanceMinor: node.balanceMinor - params.amountMinor }]));
};

/**
 * Returns part of an earlier spend to the node that made it.
 *
 * The inverse of `spend`, and it exists for one reason: a payment whose final
 * price is not known when it is authorised. A tab voucher is charged at its
 * ceiling the moment it is signed — the same "err toward having spent" rule
 * every other payment follows — and the difference comes back once the gate
 * says what the call actually cost.
 *
 * This file cannot tell a genuine release from an invented one, because it
 * does not know what was spent on whose behalf. That bound lives with the
 * caller, which does: the authority releases only against a reservation it
 * recorded itself, once, and never for more than was reserved. Here the only
 * rules are the arithmetic ones — no negative amounts, no unknown nodes.
 *
 * Conservation still holds, with the caller subtracting what it releases from
 * what it counts as spent. Money comes back into the tree only because it left
 * it; nothing is minted.
 */
export const release = (
  tree: Tree,
  params: { node: NodeId; amountMinor: bigint },
): Result<Tree> => {
  if (params.amountMinor < 0n) return err({ code: 'negative_amount' });

  const node = tree.nodes.get(params.node);
  if (!node) return err({ code: 'unknown_node', id: params.node });

  return ok(withNodes(tree, [{ ...node, balanceMinor: node.balanceMinor + params.amountMinor }]));
};

/** Everything still held anywhere in the tree. */
export const totalHeld = (tree: Tree): bigint =>
  [...tree.nodes.values()].reduce((sum, node) => sum + node.balanceMinor, 0n);

/**
 * Conservation: nothing was created, and nothing vanished except by spending.
 *
 * `totalHeld + spent === funded` must hold after every operation. It is the
 * single assertion that catches an arithmetic mistake anywhere in this file,
 * and `check.ts` asserts it after every step of every random trace.
 */
export const conserves = (
  tree: Tree,
  fundedMinor: bigint,
  spentMinor: bigint,
): boolean => totalHeld(tree) + spentMinor === fundedMinor;
