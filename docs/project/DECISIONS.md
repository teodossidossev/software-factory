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
