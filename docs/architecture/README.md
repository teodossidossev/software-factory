# Architecture

The Software Factory takes a planned ticket from a Task file to a reviewed branch with one commit,
without anyone watching a terminal in between. A planner (ChatGPT or Claude Code, through the
factory's MCP server) writes the Task file; Claude Code implements it headless, in a Git worktree
of its own, inside several sandboxes; the Codex CLI, and on risky tickets a fresh Claude session,
review every iteration; their findings become fix rounds by themselves; and when the reviews are
clean the factory runs the workspace's test command (where it has one), has the merge request text
written and makes the commit. The user reviews the result in their own IDE and alone decides what
is pushed and merged.

These pages are the architectural map, for developers and tech leads who already know agents,
MCP, skills and tools: how the parts fit, why it is safe to let it run, and why its tests can be
trusted. To install and use it, read [the user guide](../guide/README.md).

## Seven ideas

1. **The Task file is the whole contract.** Planners only plan: no planning tool starts, reviews
   or pushes anything. A fresh Task check reads the plan before Start and lists what an Implementer
   would have to decide alone ([Workflows](workflows.md#1-planning-and-the-task-check)).
2. **Agents write files; the factory does Git.** No agent runs a mutating Git command, and none
   can read the user's keys or the factory's tokens. The factory commits only the tree the
   reviewers saw, as one commit, and runs its Git with no hooks
   ([Security](security.md#what-runs-outside-the-sandbox)).
3. **Every session gets what its job needs, in layers.** A tool allow list, deny rules, a
   file-tool guard that checks real paths, Claude Code's bubblewrap sandbox, and a second
   bubblewrap wrapper around Claude Code itself; read-only sessions with no shell and no MCP
   server; the Codex gate in a wrapper with a socket filter ([Security](security.md#the-implementer-layer-by-layer)).
4. **Two vendors review, and a ledger ends the loop.** Findings get ids, contests need evidence the
   factory can find, settled findings are not argued again, and the limits count only rounds
   without progress ([Workflows](workflows.md#2-implementation-and-the-review-rounds)).
5. **The factory runs the tests itself.** A workspace's test command runs in a sandbox without
   network, on the reviewed tree, before the merge request, and again on the merged result before
   a merge; the factory writes the result into the MR text and refuses a manual check claimed as
   run ([Testing](testing.md)).
6. **Every state change is a row of one table**, checked before it is written, and every stop
   names its reason and the actions it offers ([Job lifecycle](job-lifecycle.md)).
7. **Proven on every update.** `sf smoke` runs one real job with the real Claude Code, Codex and
   Git, and probes the sandbox with canaries ([Testing](testing.md#the-live-smoke-test)).

## The pages

| Page | What it answers |
| --- | --- |
| [Overview](overview.md) | Who takes part and what each may do, the processes, where the state lives, the code by area, the decisions behind it |
| [Workflows](workflows.md) | A ticket's life from plan to merge as sequence diagrams, the run queue, the coordinator's loop, where a person decides |
| [Job lifecycle](job-lifecycle.md) | The job states and every transition the code allows, who triggers each, the loop's brakes, crash safety |
| [Security](security.md) | The threat model, the sandbox layers, denials, the guard, secrets, untrusted input, the planning connection, remote access |
| [Data flows](data-flows.md) | What leaves the machine, to which provider, under which account; confidential client data |
| [Testing](testing.md) | How the tests a change brings are guaranteed, step by step, how the factory tests itself, and the limits |

## Sources of truth

These pages explain and link; they restate no rule in full. The rules live in:

- the code: `factory/src/`, each module opening with a comment that says what it does;
- the reference, [factory/README.md](../../factory/README.md): every command, setting, state and
  code;
- [factory/HANDBOOK.md](../../factory/HANDBOOK.md): the Task file format, the review rules, the
  Git rules and the templates every agent is given;
- [the trust model](../guide/trust-model.md) and [SECURITY.md](../SECURITY.md): every denial, and
  what is protected and open today;
- [CONTEXT.md](../../CONTEXT.md): the vocabulary; [the ADRs](../adr/): the decisions and why.

Where these pages and the code disagree, the code is right and the page is to be fixed. The
examples use placeholders: `product-frontend` for a product repository, `ABC-12` for a ticket,
"the user" for the person who runs the factory.
