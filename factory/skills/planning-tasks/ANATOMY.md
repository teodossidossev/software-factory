# Anatomy

Front matter is the guide's. This file is what goes under it.

## The delivery plan

The ticket's own Task file, with `check: skip`. It is the plan's memory outside the chat: a new
session continues from it, and the slices take their shared names from it. Its first line under
the title says so: it is the index of the ticket's slices, and no job is started on it.

- **Status**: one line: `grilling`, `prototyping`, `cut agreed`, `writing (n of m green)` or
  `planned`; and the base commit.
- **Decisions**: each product decision the user made: an id (`D-1`), one sentence, and what it
  overrides in the request, an image or a document; a decision the user took on a prototype names
  its file.
- **Prototypes**: each prototype: its file, the question it answers, the user's reactions and the
  decisions they became; or why the ticket has none.
- **Cut**: the table the user approved: slice, kind, what, size, depends on.
- **Contracts**: every name one slice introduces and another relies on (a component, a function
  with its signature, a translation key, a test id), with the slice that owns it.
- **Lessons**: the rules learned from Task checks, for the slices not yet written.
- **Visual references**: each image, and what in it is superseded by which decision.

## A slice's Task file

`scope:` equals the Files list, path for path. Product slices carry `check: required`.

1. **Lead**: `Slice n of m (kind)`, then two sentences: what changes and why.
2. **Delivery context**: the cut, one line per slice, this one marked.
3. **Sources and standards**: the documents that bind the slice, by path and section. The
   paragraph of a decision document the slice keeps, and the one it amends. The vision statements
   the slice changes on purpose, by id. One exemplar in the repository to imitate, by path: one the conventions endorse.
4. **Builds on**, for a slice that builds on slices not merged yet: each of them by key, and the
   contract this slice uses, copied from that slice's Task word for word: the files, names and
   signatures it introduces. State it as the precondition: the Implementer starts on a base that
   holds them. The check's repository does not hold them yet, so every claim about that code
   cites the earlier slice's Task.
5. **Required change**: numbered. Each item names the file and symbol it touches and **pins**
   what it introduces: names, signatures and types, translation keys with their text in every
   language file, test ids, roles and keys, messages with their exact text and one rendered
   example each, the default, empty, loading and error states, where focus goes.
6. **Preserved behaviour**: each thing that must stay as it is, as a sentence a test can check.
7. **Acceptance criteria**: ids (`XX-1`), each observable by a user or a test.
8. **Files**: Create, Modify, Delete. One line per file on what changes. Tests, stubs and
   documents included.
9. **Validation**: for each criterion, the test that proves it, at the level the repository's
   rules assign. For a slice that must change nothing, the existing tests that pin the behaviour.
   The commands to run.
10. **Not in this slice**: what is left, and the slice that takes it.
11. **Review brief**: what the reviewers check, and why the decisions were made.

The Implementer sees this file alone: restate each decision the slice rests on, with its id. A
decision taken on a prototype is restated in words: the Implementer, the Task check and the
reviewers cannot open the prototype.

A choice the user did not make is the user's to make first. Where the guide lets you take it
yourself, it goes under the guide's heading "Decisions taken without asking", with its reason.
Removing a test, or narrowing what one covers, is such a choice.

## Zero-decision audit

Before each `write_task`, read the draft as two Implementers who cannot talk to each other.
Wherever they could build different things, decide: with a fact from the trace, or with a question
to the user.

- Search the draft for the words that mark an open choice (`or`, `if`, `as appropriate`,
  `such as`, `e.g.`, `where it fits`, `similar`, `etc.`) and replace each with the decision.
- Every claim about the code carries the `path:line` the trace gave. A function named carries its
  module when two modules export that name.
- Every row of the trace's Files table is in Files and in `scope:`. Every consumer file the trace
  found is either changed there or named as unaffected, with the reason; the callers of one
  shared helper go on one line, as a count.
