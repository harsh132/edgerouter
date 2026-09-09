/**
 * What an agent is allowed to do, named once.
 *
 * The strings here are the vocabulary the `scope` caveat carries, and they are
 * a closed set on purpose. An open-ended list of whatever the user typed cannot
 * be enforced — something has to recognise the string and refuse — so a
 * permission that is not in this file is a permission that does nothing, and it
 * is better for that to be visible at the point of granting than at the point
 * of a silent no-op.
 *
 * ## Nothing here means "all"
 *
 * There is deliberately no permission granting every other permission, present
 * or future. A capability is signed over the caveats it carries, so a grant
 * naming a set that grows after signing hands its holder powers nobody agreed
 * to — the agreement was to the set as it stood. When a permission is added
 * below it reaches nobody until somebody grants it, including the agent that
 * was meant to have everything.
 *
 * The workflow that wanted `all` — one agent you talk to, which works out what
 * the others need and grants it — is `delegate` plus an explicit list of what
 * that agent may hand out. Same convenience, and the blast radius is written
 * down.
 *
 * ## What is not here
 *
 * Spending is not a permission. The ceiling and the host list already answer
 * "how much" and "to whom", and a second answer to a question that already has
 * one is how the two come to disagree.
 */

/** Every permission this build understands. */
export const PERMISSIONS = {
  'files:read': {
    label: 'Read its own files',
    detail: 'List, read and search the workspace that belongs to it. Nothing outside.',
  },
  'files:write': {
    label: 'Write its own files',
    detail: 'Create and replace files in its own workspace. Work that outlives one task.',
  },
  'delegate': {
    label: 'Fund other agents',
    detail: 'Hand part of its own budget to another agent. It can never hand over more than it holds.',
  },
  'budget:request': {
    label: 'Ask for more budget',
    detail: 'Request a raise when it runs out, rather than simply stopping.',
  },
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * What an agent gets when nobody said otherwise.
 *
 * Its own workspace and nothing else — which is what every agent hired before
 * permissions existed already had, so upgrading an install changes no
 * behaviour. The two that touch other agents are off by default because a
 * default is a decision nobody made.
 */
export const DEFAULT_PERMISSIONS: Permission[] = ['files:read', 'files:write'];

/** Whether a string is a permission this build enforces. */
export const isPermission = (value: string): value is Permission => value in PERMISSIONS;

/**
 * Keeps only the permissions that mean something here.
 *
 * A stored agent can name a permission this build has never heard of — written
 * by a newer version, or edited by hand — and carrying it into a capability
 * would mint a token asserting something nothing can check. Dropped rather than
 * refused: the agent still works, with less.
 */
export const knownOnly = (asked: readonly string[]): Permission[] => asked.filter(isPermission);
