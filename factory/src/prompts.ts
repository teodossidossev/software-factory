// The fixed block the factory appends to every prompt it sends to the Implementer: the factory's
// rules and the Report template, which the Implementer cannot read anywhere else.
export const FACTORY_PROMPT_RULES = `Rules from the Software Factory:
- Do not commit, stage, stash, push or switch branches; the factory handles Git after review.
- Do not edit .software-factory/<ticket>.md; the Context owner owns it.
- End your turn with a report in this form, as your last message:
  # Report: <ticket>, iteration <N>
  ## Done        (what was built or changed, by responsibility)
  ## Checks      (each command run with its result; "not run" and why, when not run)
  ## Open questions   ("None." when there are none)
  ## Fix N items (only when answering a Fix section: a table of each item, fixed or rejected, with a note)`;

// first: the command or the user's message; iteration: the number of the iteration to be published.
export function factoryPrompt(first: string, ticket: string, iteration: number): string {
  return `${first}\n\n${FACTORY_PROMPT_RULES.replaceAll('<ticket>', ticket).replace('<N>', String(iteration))}`;
}

// This iteration's cost from the SDK's cumulative session total; a total below the previous one
// means a new session started, so the total is this iteration's cost.
export function iterationCost(total: number | null, previousTotal: number | null): number | null {
  if (total === null || previousTotal === null || total < previousTotal) {
    return total;
  }
  return Math.round((total - previousTotal) * 1e6) / 1e6;
}
