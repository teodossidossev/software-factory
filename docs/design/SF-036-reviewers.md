# SF-036 design: API reviewers and factory-owned Git

Status: agreed 2026-11-04. Decision: [ADR-0005](../adr/0005-api-reviewers-and-factory-git.md).
Vocabulary: `CONTEXT.md`. Replaces the reviewer and MR preparation parts of
[SF-011](SF-011-factory.md); the rest of SF-011 and ADR-0004 stands.

## 1. The cycle

```
plan in ChatGPT ─► write_task ─► user: Start ─► iteration ─► Claude review
                                                   ▲              │ fix: ## Fix N
                                                   └──────────────┤
                                                                  │ clean
                                                                  ▼
                                                 gate (Codex)  ── fix: ## Fix N ─► iteration
                                                                  │ clean
                                                                  ▼
                                    factory: MR text turn, commit, rebase ─► ready_for_human_review
                                                                  │
                                    user: approve (push) / abort / say / ask for a fix
```

The user types nothing between Start and their own review. A fix asked during human review
(`say`) runs an iteration and goes through both reviews again.

## 2. States

The states of SF-011 stay. `awaiting_review` now means a review (Claude or the gate) runs or is
due; `check` and the dashboard show which. New error codes: `review_failed`, `gate_failed`,
`gate_rounds`, `gate_budget`, `mr_conflict`.

## 3. Reviewer input and output

Input, the same for both reviewers: the Task file (with its `## Review brief`), the Report, the
Patch, the sensitive and deleted paths of the iteration, the review rules of the Handbook.

Output:

```json
{ "verdict": "clean" | "fix",
  "summary": "<why, including every undeclared sensitive path accepted>",
  "items": [{ "path": "<file>", "problem": "<what is wrong>", "expected": "<what is expected>" }] }
```

`fix` with items becomes `## Fix N`, one numbered item per entry. `clean` accepts the undeclared
sensitive paths the summary names; one it does not name is a fix item.

- **Claude**: a fresh Agent SDK `query()`, `cwd` the worktree, tools `Read`, `Grep`, `Glob` only,
  `outputFormat` with the schema above. Its text, verdict and cost are kept with the iteration.
- **Gate** (amended 2026-11-04, SF-039): the Codex CLI on the user's ChatGPT subscription, no API
  key: `codex exec --ephemeral --sandbox read-only --cd <worktree> --output-schema <file>
  --output-last-message <file> --json [--model SF_CODEX_MODEL] -`, the prompt on stdin, the
  environment without `SF_*`. Codex reads the worktree itself (read-only commands such as `git diff
  <base_commit>`, `rg`, reading files; no credentials), so the factory implements no function
  tools. The output schema is the one above in strict form (every property required,
  `additionalProperties: false`); token usage comes from the JSONL events. Runs only after a clean
  Claude verdict. Recorded in `iterations/NNN/gate.json`.

## 4. Rules

| Rule | Value |
|---|---|
| Fix sections without Clean | `SF_MAX_ITERATIONS` (default 5), counted on Fix sections, then `needs_human` |
| Gate rounds with fixes | `SF_GATE_MAX_ROUNDS` (default 3), then `needs_human` with both verdicts |
| Gate tokens per ticket | `SF_GATE_MAX_TOKENS` (default 5000000, input plus output), then `needs_human` with `gate_budget` |
| Gate run time | `SF_GATE_TIMEOUT_MS` (default 900000), then `needs_human` with `gate_failed` |
| Disagreement | the gate decides |
| Gate off | `SF_GATE=off`, or no Codex executable (`SF_CODEX`, else `codex` on `PATH`); the Claude verdict decides |

## 5. Git at Clean

1. Resolve the target (`git fetch origin <base>`).
2. One Implementer turn writes `.software-factory/<ticket>.mr.md`; all mutating Git stays denied.
3. The factory validates the text, then: `git reset --soft <base_commit>` when the branch has
   commits on top of it, `git add --all -- <Patch paths>`, `git commit` (MR title, `## Why` as the
   body), `git rebase <target>`; a conflict is `git rebase --abort` and `needs_human`
   (`mr_conflict`, the paths).
4. MR text to the job, worktree removed, `ready_for_human_review`. Approve pushes, as before.

## 6. What ChatGPT keeps

The tunnel with "No authentication", MCP tools `guide`, `read_file`, `search`, `write_task`, and
the Handbook as the planner's guide. Everything else of the MCP surface goes.

## 7. Order of work

| Ticket | Change |
|---|---|
| SF-036 | This design, ADR-0005 |
| SF-037 | The factory commits and rebases at Clean |
| SF-038 | Claude reviews every iteration |
| SF-039 | The Codex gate before Clean (amended 2026-11-04: Codex CLI on the ChatGPT subscription, not the OpenAI API) |
| SF-040 | Remove the ChatGPT execution transport |
| SF-041 | Start button and MR text copy on the dashboard |
| SF-042 | Each job runs in its own process |
