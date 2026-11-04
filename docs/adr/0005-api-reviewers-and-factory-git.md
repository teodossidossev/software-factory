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

## Context

ADR-0002 made the planning ChatGPT conversation the reviewer and woke it with a scheduled task;
SF-015 to SF-035 replaced the schedule with MCP Events, which needed OAuth (Auth0), a callback
store, signed webhooks, retries, one subscription per ticket and a nudge for a reviewer that
stopped. That transport became about half of the factory's code and most of its incidents: a
connection lost for half a day when an access token expired, the OIDC flag, a reviewer that read
the Patch and stopped twice in one ticket. The value it carried is a reviewer trained by another
company than the Implementer's; that value does not need the ChatGPT web conversation.

MR preparation was a turn of the Implementer inside the sandbox. On the first ticket of another
repository (GWP-3862) `git rebase` could not unlink the sandbox's `.gitmodules` placeholder, the
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
