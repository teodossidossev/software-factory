---
status: accepted
date: 2026-11-04
supersedes: 0002
amends: 0003, 0004
---

# Claude and an OpenAI model review through the API; ChatGPT only plans; the factory does Git

ChatGPT stays the model the user plans with, but only plans: a read-only connection to the
workspace (`guide`, `read_file`, `search`, `write_task`, no authentication, through the tunnel)
and a Task file that carries a `## Review brief`. Every published iteration is reviewed by a fresh
read-only Claude session; when it finds nothing, an OpenAI model called through the API gives the
independent verdict before Clean (the gate). At Clean the factory commits and rebases itself,
outside the sandbox; the Implementer only writes the merge request text. The user starts a job
from the dashboard or the terminal. Each job runs in its own process.

**Amended 2026-11-04 (SF-039):** the gate is the Codex CLI (`codex exec`) on the user's ChatGPT
subscription, not the OpenAI Responses API: the user has a subscription, not API access. Codex
reads the worktree itself in its read-only sandbox, so the factory implements no function tools,
and no API key is needed; the gate is off when no Codex executable is found (or with
`SF_GATE=off`). The token ceiling protects the subscription's limits rather than money. The
Decision and Consequences below are read with this amendment.

**Amended 2026-11-04 (SF-047):** the user can override the gate once it stops a job. After its
rounds or its token budget run out (`gate_rounds`, `gate_budget`), or when it fails
(`gate_failed`), and only while Claude's review of the last iteration is clean, `sf accept` or
*Accept and prepare MR* on the dashboard takes the job on to MR preparation as a clean gate would.
SF-045 hit the round limit twice with Claude clean and Codex finding ever narrower variants, and
the only way on was `sf say`, which starts yet another iteration. The override is a deliberate,
confirmed step of the user, never the factory's: the Codex items not applied are listed before it
is confirmed, recorded in `gate-override.json` with a `gate_overridden` event, and shown under the
MR text for a follow-up ticket. "Every change that reaches the branch passes" the gate therefore
reads: passes it, or is accepted over it by the user with what it asked for on record.

**Amended 2026-11-05 (SF-051):** a nit never blocks. Every review item has a severity: `blocker`
(the change is wrong, unsafe or breaks the Task's acceptance), `major` (a real defect or a Task
requirement not met, but contained) or `nit` (style, naming, wording, a narrower variant of a risk
already accepted, a nice-to-have). The factory, not the reviewer, decides, the same way for both
reviewers: a round is a fix only with a blocker or major item, or an undeclared sensitive path not
accepted (always major); a `fix` with nits only goes on as clean. On SF-045 the gate held the job
in fix rounds with ever narrower items, each a Fix section whatever its weight. Nits are not lost:
in a fix round they follow the blocking items as optional, and those of the iteration that reaches
Clean go into the MR text as `### Nits not applied`, written by the factory.

**Amended 2026-11-05 (SF-052): how the review loop ends.** Every round is a fresh reviewer, so each
round samples new items, and a loop that ends only at zero items may never end (SF-045: five gate
rounds, about 2.4M tokens, ever narrower variants of one risk). The loop now keeps a ledger of
findings (`ledger.json`): every item of a Fix section gets an id, and the Implementer answers each
one `fixed`, `contested` (only with evidence a reviewer can check: a `path:line`, a test, a
`§section`; otherwise it stays open), `escalated` (a question only the user can answer, which stops
the job before the review) or `left` (nits only). The reviewers see every settled finding and may
not raise it again, nor a narrower variant; they reopen one only with evidence, by its id. The
factory, not the reviewer, applies the ledger to a fix verdict: an item that reopens a risk the user
accepted is dropped; one that reopens a contest goes to the user as a dispute (`review_disputed`);
a fix reopened a second time, or a round whose every blocking item was caused by earlier fixes, is
churn (`review_churn`). Each stop asks the user one question: accept and prepare the MR (with a
clean Claude review; the open findings are recorded as not applied), continue (`sf settle`, `sf
say`), or go back to planning. The loop ends at one clean gate, or at the user's decision; the
"two consecutive clean rounds" of the Elephant–Goldfish model is not adopted, since a gate round
costs hundreds of thousands of tokens and its verdict decides. `SF_GATE_MAX_ROUNDS` stays the cap.
The MR text lists the accepted risks, contests and nits left as `### Review findings not fixed`.
The known limit: the factory matches an accepted risk by its id or by the same path and problem
text; a narrower variant in new words is kept out only by the reviewers' rule in the prompt.

**Amended 2026-11-05 (SF-055): a pass after the reviewers.** Reviewers add; nobody removes (SF-045:
the security rounds grew `src/redact.ts` to 436 lines and about 500 lines of tests, and no step
asked whether all of it was needed). Like the intermediate zoom-out of the Elephant–Goldfish model,
the factory runs one simplification pass per job after the deciding clean verdict, when the job had
at least one Fix section (`SF_SIMPLIFY`, on by default): a fresh read-only Claude session like the
review reads the Task file without its Fix sections, the final Patch, the ledger and the files each
Fix changed, and names what exists only to satisfy a review item and is not needed for the Task's
goal, its acceptance or a blocker or major finding still valid. It may never propose undoing what a
`fixed` blocker needed: the prompt names those ids and paths, and the factory drops any suggestion
that names one or is on the path of one, without trusting the ids the pass gives. It only suggests; the user decides. Simplify writes one Fix section "Simplify" that goes
through the Claude review and the gate as usual, and records each suggestion in the ledger as the
user's accepted choice, so a reviewer cannot ask for it back while a defect the removal causes is a
new finding (or reopens the blocker it undid). Skip prepares the MR with the suggestions listed
under `### Simplifications not applied`, for a follow-up ticket. A failed pass never stops the job,
and the pass never runs twice on a job (the job records it before it starts), so it cannot become
a loop of its own.

## Context

ADR-0002 made the planning ChatGPT conversation the reviewer and woke it with a scheduled task;
SF-015 to SF-035 replaced the schedule with MCP Events, which needed OAuth (Auth0), a callback
store, signed webhooks, retries, one subscription per ticket and a nudge for a reviewer that
stopped. That transport became about half of the factory's code and most of its incidents: a
connection lost for half a day when an access token expired, the OIDC flag, a reviewer that read
the Patch and stopped twice in one ticket. The value it carried is a reviewer trained by another
company than the Implementer's; that value does not need the ChatGPT web conversation.

MR preparation was a turn of the Implementer inside the sandbox. On the first ticket of another
repository (a product ticket) `git rebase` could not unlink the sandbox's `.gitmodules` placeholder, the
repair was denied, and the job ended at the iteration limit. The snapshot ref and the three-way
diff check existed only to verify Git work a model had done.

## Decision

- **Planner.** ChatGPT reads the repository and writes the Task file. It never starts, reviews or
  cleans a job. The Task file's `## Review brief` carries what the reviewers must check and why
  the plan's decisions were made.
- **Review of every iteration.** A fresh Agent SDK `query()` in the worktree, read-only, with
  structured output (clean, or Fix items with path, problem, expected and, since SF-051, severity).
  Blocker and major items become the next `## Fix N` and the next iteration starts at once; nits
  never block.
- **Gate.** On a clean Claude verdict, an OpenAI model through the Responses API, with read and
  search over the worktree as function tools, gives the verdict that decides. At most five gate
  rounds with fixes, then `needs_human` with both verdicts, which the user can accept over the
  gate (SF-047 amendment above); a per-ticket token ceiling. Every
  change that reaches the branch passes it, including a fix asked during human review. Without
  an OpenAI key the gate is off and the Claude verdict decides.
- **Git at Clean.** The Implementer writes `.software-factory/<ticket>.mr.md`; the factory adds the
  Patch's paths, makes one commit and rebases onto the target. A conflict aborts the rebase and
  hands the job to the user.
- **Start.** The dashboard's Start button or `sf start`.
- **Process.** A job's turns, reviews and gate run in a process of their own, so a restart of
  `sf serve` does not interrupt them.

## Considered options

- ChatGPT reviewing through a scheduled task (ADR-0002): keeps the planning conversation, but the
  Idle gap is the schedule's interval.
- ChatGPT reviewing through MCP Events (SF-016): no Idle gap, but the transport above.
- Claude reviewing alone: simplest, but a model reviewing work of its own kind shares its blind
  spots. Kept as the first stage, where it is cheap and has the whole repository.

## Consequences

- Removed: MCP Events, OAuth and Auth0, the execution tools over MCP, the Reviewer block,
  `sf ticket`, `sf events`, the nudge, the snapshot ref and the three-way diff check.
- An OpenAI API key and per-review API cost; the planning conversation is not online at review
  time, which the review brief replaces.
- The iteration limit counts Fix sections, so a message of the user does not use it up.
- ADR-0003 still holds for the Implementer; the reviewers are separate sessions. ADR-0004 holds
  except that MR preparation is the factory's.

## Amendment 2026-11-14 (SF-214): the joint round

What changes: on a job with the Claude review, both reviewers review each iteration in the same
round, at the same time. The gate no longer waits for a clean Claude verdict. An iteration is
Clean only when both verdicts are clean; the fix items of both make one Fix section, an item both
raise is one item and one ledger entry, and each item names who raised it.

Why: the user's decision, to cut a review cycle's wall-clock time while keeping the Claude
review's findings (about a third of the serious findings on company code). On 2026-11-13, over
the product workspaces' jobs, 9 of 44 Claude verdicts were `fix`, so the gate never saw those
iterations, and after a clean one the gate said `fix` in 16 of 33: each reviewer's findings cost
an iteration of their own.

The rest of this ADR stands.

## Amendment 2026-11-16 (SF-131): the Codex gate is the main reviewer

What changes: the Codex gate is the main reviewer. The Claude review runs only on a ticket whose
Task file says `review: claude`, or, with `SF_CLAUDE_REVIEW=always`, on every ticket but those that
say `review: codex`; with the gate off it reviews every job. A job without the Claude review has
the gate as its only reviewer, at gate level `full` on every iteration, and `SF_GATE_MAX_ROUNDS`
does not apply to it. Fix sections are capped at 3 (`SF_MAX_ITERATIONS`); at the cap Accept takes
the iteration whatever the last verdict, and its open findings are listed in the MR text.

Why: the audit of 2026-11-07 (`docs/audits/2026-11-07-audit.md`): the gate found 94 blocker or
major items (58 fixed), the Claude review 20 (6 fixed) for 18% of the cost, and jobs with 4 or more
iterations were 36% of the cost. The user agreed to a two-week experiment.

The rest of this ADR stands, read with this amendment.
