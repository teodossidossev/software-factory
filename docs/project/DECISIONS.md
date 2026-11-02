# Project decisions

Decisions approved by the user. Add new entries at the end and keep earlier entries as they are.

## 2026-10-31: setup belongs to the repository

Setup must belong to the repository and support checkout, configuration and a common start command.

Status: planned, not implemented. Proposal `sf010-reproducible-setup-20261031` is deferred.

## 2026-10-31: cleanup and a baseline commit come first

Repository cleanup and a baseline commit come before the reproducible bootstrap task.

## 2026-10-31: limited commit authorization for the cleanup

For the cleanup and checkpoint task only, the user explicitly authorizes staging and committing the
selected completed work. This replaces the earlier blanket no-stage/no-commit rule in that limited
scope. No push, reset, clean, stash, history rewrite, branch change or additional checkout is
authorized.

The managed job makes no Git mutation, because the supervisor would end it as
`git_operation_detected`. The stage and commit run from an operator-controlled host terminal after
independent review, explicit result acceptance and verified job closure.

## 2026-10-31: roles

ChatGPT remains context owner and independent reviewer, Claude implements, OpenClaw is transport, and
the user retains final result acceptance.

## 2026-11-01: SF-011 replaces the earlier direction

These decisions replace the roles entry of 2026-10-31 and the setup proposal. The earlier entries
stay as history.

- **Roles.** The Context owner is the model the user plans with, ChatGPT first. It plans, writes
  the Task file, reviews and declares Clean. Claude Code implements, headless, in the work
  checkout. The user reviews the branch in IntelliJ and approves in the terminal (`sf approve`).
- **Transport.** No OpenClaw and no MCP Events. The Context owner polls with a ChatGPT scheduled
  task that calls `check` (ADR-0002).
- **Checkout.** No worktrees and no iteration commits. The Implementer works in the work checkout
  and commits nothing during iterations (ADR-0001).
- **Commits.** One commit per merge request, by the Git rules in `factory/HANDBOOK.md`, made in MR
  preparation after approve. Nothing is pushed to main directly; every change goes through a merge
  request.
- **Task files.** Task files live in `.software-factory/` of the work checkout and are ignored by
  Git.
