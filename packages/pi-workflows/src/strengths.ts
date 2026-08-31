/**
 * strengths.ts — the workflow strength vocabulary.
 *
 * A workflow speaks one word about cost: how much effort a step deserves. It
 * does not speak "tier". A script names a strength, the user's `strengths`
 * table says which Agent tier each strength runs on, and pi-subagents resolves
 * that tier the way it resolves every other one.
 *
 * The vocabulary is closed on purpose. An open one would have no typo to catch
 * — every misspelling would be a legal strength nobody had configured, which
 * dispatches silently instead of failing — and `/workflows strength` could not
 * show a complete list of what there is to configure. Three effort levels are
 * what a workflow can meaningfully distinguish; a fourth would be a model
 * policy wearing a strength's name.
 *
 * Deliberately not derived from the shipped scripts. The set is the contract
 * a script author writes against, so it has to be listed where the author and
 * the settings menu can both read it, not inferred from whichever words the
 * built-ins happen to use this release.
 *
 * There is deliberately no *default* strength either. A call that names none
 * dispatches with no tier at all and takes the agent's ordinary default — its
 * own frontmatter tier, then the host's configured one — exactly as an unmapped
 * strength does, and exactly as every non-workflow Agent spawn does. Defaulting
 * to `medium` was tried and is wrong: a tier a call requests outranks the agent
 * type's own (`selectAgentTier` in pi-subagents: `call` before `frontmatter`),
 * so on a stock install — where the shipped table maps `medium -> medium` —
 * every unlabelled dispatch would have pinned `medium` over whatever the agent
 * declared. `Explore` ships with `tier: low` precisely so read-only search stays
 * cheap; a default strength would have silently overruled it, and re-priced in
 * the wrong direction the one agent this indirection exists to leave alone.
 * Nothing is lost: a script that named no strength stated no opinion, and the
 * host's ordinary precedence is the right answer to that. What the table must
 * reach is every call a script did label, and the shipped scripts label all of
 * theirs.
 */

/** Every strength a script may name, cheapest first. */
export const WORKFLOW_STRENGTHS = ["low", "medium", "high"] as const;

export type WorkflowStrength = (typeof WORKFLOW_STRENGTHS)[number];

/**
 * A strength -> Agent tier table.
 *
 * Keyed on the closed vocabulary rather than on `string`, because every table
 * that reaches a run has already passed {@link isWorkflowStrength} on each key:
 * the settings layer drops the rest at read, and `runWorkflow` drops them again
 * for callers that reach it through JS without types. Partial because an
 * omitted strength is a real state — unmapped, taking the agent's own default —
 * and not a hole.
 */
export type WorkflowStrengthTable = Readonly<Partial<Record<WorkflowStrength, string>>>;

export function isWorkflowStrength(value: unknown): value is WorkflowStrength {
  return typeof value === "string" && (WORKFLOW_STRENGTHS as readonly string[]).includes(value);
}

/** The vocabulary as a bare list, for error messages and menus. */
export const WORKFLOW_STRENGTH_LIST = WORKFLOW_STRENGTHS.join(", ");

/**
 * The table a host uses before anyone configures one: each strength on the
 * catalogue tier that shares its name, and only where the host defines one.
 *
 * Shipped as a *table*, not as a resolution rule, and that distinction is the
 * whole design. A rule saying "an unmapped strength falls back to the tier of
 * the same name" would be unremovable — the way the old passthrough was — so a
 * fan-out could never be re-priced without dragging every ordinary spawn that
 * names the same tier along with it. A default table is just the first entry in
 * the same slot the user writes, so replacing it is one command, and the user's
 * table still remains the only thing that binds a strength to a tier.
 *
 * Computed against the live catalogue rather than hardcoded, because a shipped
 * constant would be an assertion about someone else's tier names — exactly the
 * claim the retired `shippedScript` flag existed to walk back. On a host whose
 * tiers are called `cheap`/`deep` this yields nothing, every strength is
 * unmapped, and no run start complains about configuration the user never
 * wrote. On a stock install it yields the identity table, so the shipped
 * scripts' `low`/`medium` distinctions mean something out of the box instead of
 * collapsing onto the managed default — which is the more expensive rung.
 *
 * An unknown catalogue yields nothing for the same reason: assert only what can
 * be checked.
 */
export function defaultStrengthTable(knownTiers: ReadonlySet<string> | undefined): WorkflowStrengthTable {
  const table: Partial<Record<WorkflowStrength, string>> = {};
  if (!knownTiers) return table;
  for (const strength of WORKFLOW_STRENGTHS) {
    if (knownTiers.has(strength)) table[strength] = strength;
  }
  return table;
}
