# Software Factory: the user guide

This guide takes you from a machine without the factory to a merged change made by it, and then
through everything you do with it from day to day.

## What the factory is

The Software Factory is a local tool for one person on one machine. You plan a ticket (with ChatGPT,
with Claude Code, on the dashboard or by hand) into a **Task file**; the factory then runs
Claude Code headless on it in a Git worktree of its own, has every iteration reviewed by a fresh
Claude session and by the Codex CLI, turns their findings into fix rounds by itself, and when both
are clean writes the merge request text, makes one commit and rebases it. You get the result in
your own checkout (or push it from the dashboard), review it, and push or merge. It exists to remove
the **idle gap**: the time between Claude finishing and someone noticing. Nobody has to watch a
terminal between Start and your own review.

## Who this guide is for

A developer who has never seen the factory and wants to use it on their own repositories: install
it, configure it, plan tickets, run them and get the result merged, from these pages alone. You
should know Git and a terminal; you do not need to know the factory's code.

The guide explains and walks through. The exhaustive specification of every behaviour is the
reference, [factory/README.md](../../factory/README.md); the exact meaning of every term is in
[CONTEXT.md](../../CONTEXT.md). Where this guide says "see the reference", the reference has the
detail.

## Reading order

Read the first four pages once, in order; the rest when you need them.

1. [Concepts](concepts.md): the process, the vocabulary and the job states.
2. [Install](install.md): prerequisites, the two ways to run it, the first start, `sf smoke`.
3. [Configuration](configuration.md): every setting, the workspace registry, the rules files, the
   queue, the Task file's front matter.
4. [Planning a ticket](planning.md): the four ways to write a Task file, what makes a good one, the
   Task check.
5. [Running jobs](running-jobs.md): Start, the queue, the job page, talking to a job, pause and
   restart, usage limits.
6. [Review and merge](review-and-merge.md): the hand-over to your checkout, pushing and opening the
   merge request, the MR text.
7. [When a job stops](when-a-job-stops.md): every reason a job stops for you and what to do.
8. [Operations](operations.md): updating, status and metrics, logs, cleaning, backup,
   troubleshooting, the tests.
9. [Ways of working](ways-of-working.md): end-to-end recipes, alone, with the queue, with a
   coordinating session, with ChatGPT, in a team.
10. [The trust model](trust-model.md): what each agent session can and cannot reach, what the
    factory does outside the sandbox, and the limits.

## I want to …

| I want to … | Read |
| --- | --- |
| understand what happens between Start and the merge | [Concepts](concepts.md) |
| install the factory on my machine | [Install](install.md) |
| check that an install works end to end | [Install: check that it works](install.md#check-that-it-works) |
| keep a stable install while I change the factory's code | [Install: a second clone to run from](install.md#b-a-second-clone-used-only-to-run-the-factory) |
| add my repository | [Install: the first start](install.md#the-first-start) and [Configuration: workspaces.json](configuration.md#the-workspace-registry-workspacesjson) |
| change a model, a limit or a port | [Configuration: the environment file](configuration.md#the-environment-file-authenv) |
| give the agents my own coding rules | [Configuration: rules files](configuration.md#coding-rules) |
| plan a ticket with ChatGPT | [Planning: with ChatGPT](planning.md#1-with-chatgpt-through-the-tunnel) |
| plan a ticket with Claude Code | [Planning: with Claude Code](planning.md#2-with-claude-code-or-another-mcp-client-on-the-local-server) |
| write a Task file myself | [Planning: by hand](planning.md#4-writing-the-task-file-by-hand) |
| know whether a Task file is good enough | [Planning: the Task check](planning.md#the-task-check) |
| run several tickets one after another | [Running jobs: the queue](running-jobs.md#starting-a-job) and [Ways of working](ways-of-working.md#2-several-tickets-at-once-through-the-queue) |
| tell a running job something | [Running jobs: talking to a job](running-jobs.md#talking-to-a-running-job) |
| get the result into my IDE | [Review and merge: the hand-over](review-and-merge.md#1-the-hand-over-to-your-checkout) |
| have the factory open and merge the MR | [Review and merge: the Merge request screen](review-and-merge.md#2-pushing-and-opening-the-merge-request-from-the-factory) |
| find out why a job stopped and what to do | [When a job stops](when-a-job-stops.md) |
| update the factory without breaking running jobs | [Operations: updating](operations.md#updating-the-factory) |
| fix "port in use", a lost dashboard URL or an expired login | [Operations: troubleshooting](operations.md#troubleshooting) |
| set the factory up for colleagues | [Ways of working: a team](ways-of-working.md#5-a-team) |
| know what an agent can read on my machine | [The trust model](trust-model.md) |

## The other documents

- [factory/README.md](../../factory/README.md): the reference (commands, environment, jobs, the
  dashboard, every code).
- [factory/HANDBOOK.md](../../factory/HANDBOOK.md): what the planning model (the Context owner)
  is told: the cycle, the tools, the Task file format, the review rules, the Git rules, the
  templates.
- [CONTEXT.md](../../CONTEXT.md): the vocabulary.
- [docs/adr/](../adr/): the architecture decisions and why they were made.

Next: [Concepts](concepts.md).
