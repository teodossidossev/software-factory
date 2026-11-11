# The agents' skills

Copies of the skills the factory's agents use, from Matt Pocock's skills
(https://github.com/mattpocock/skills), as installed in `~/.agents/skills` by the `skills` tool.
The factory gives a job these copies, not the user's installed ones, so every job runs the same
reviewed version on any machine. A change to a skill goes through a pull request like any other.

- `implement`, `tdd` and `code-review`: the Implementer (its first prompt is `/implement <Task file>`).
- `code-review`: the method of the Claude review and the Codex gate.
- `grilling`: the method of the Context owner's planning.

| Skill | Path in the source repository | Folder hash | Updated |
| --- | --- | --- | --- |
| `implement` | `skills/engineering/implement/SKILL.md` | `4804b466ab26c9b9d8d42917547db133d1f20a9f` | 2026-11-09 |
| `tdd` | `skills/engineering/tdd/SKILL.md` | `667dbdd00c09d0e2189e082986e6a4d61a67c2a6` | 2026-11-09 |
| `code-review` | `skills/engineering/code-review/SKILL.md` | `a8ef561571acbb611de8ff19ba6da75b197c63a8` | 2026-11-09 |
| `grilling` | `skills/productivity/grilling/SKILL.md` | `f551b6e0d219fdda0b6abf277f8f915b3127d1e9` | 2026-11-09 |

## Changes from the source

- `implement`: the work is the Task file, not a ticket fetched from an issue tracker; and the last
  step is "Do not commit: the factory commits your work after its reviews", not "Commit your work
  to the current branch". A job never commits; the factory commits after the reviews.

`npm run sync-skills` replaces the skill folders whole: re-apply these changes in the same pull
request.
