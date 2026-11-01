# software-factory

The local factory process. It serves MCP tools to the Context owner (ChatGPT or any MCP client)
and provides the `sf` command. How to work with it is in [HANDBOOK.md](HANDBOOK.md); the
vocabulary is in [../CONTEXT.md](../CONTEXT.md).

This package currently provides the planning tools: `guide`, `read_file`, `search` and
`write_task`. The execution tools (`start`, `check`, `request_fix`, `mark_clean`) follow.

## Commands

```sh
npm install && npm run build      # once, inside factory/
bin/sf workspace add <name> --read <path> [--work <path>]   # --work defaults to --read
bin/sf workspace list
bin/sf workspace remove <name>
bin/sf serve                      # foreground; Ctrl+C stops it
npm run typecheck && npm test
```

Exit codes: 0 ok, 1 error, 2 usage.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SF_PORT` | `8788` | Port of `http://127.0.0.1:<port>/mcp` (loopback only, Host and Origin checked). |
| `SF_CONFIG_DIR` | `${XDG_CONFIG_HOME:-~/.config}/software-factory` | Directory of the workspace registry. |
| `SF_HANDBOOK` | `factory/HANDBOOK.md` | Handbook served as instructions (its `## Quick start` section) and by `guide`. |

## Workspace registry

`<config dir>/workspaces.json`, written by `sf workspace add|remove`:

```json
{ "workspaces": { "my-app": { "read_checkout": "/abs/path", "work_checkout": "/abs/path" } } }
```

Names are 1-64 characters of `a-z`, `0-9` and `-`, starting and ending with a letter or digit.
Both paths must be absolute and, whenever a tool uses them, the root of a non-bare Git work tree.
An invalid file is an error, never ignored. `read_file` and `search` use the read checkout;
`write_task` writes `.software-factory/<ticket>.md` in the work checkout and adds
`.software-factory/` to its `.git/info/exclude`.

## Replacing `bridge/`

`factory/` replaces the SF-001 to SF-010 bridge: one process with a Workspace registry instead of a
single fixed repository root, Task files instead of `factory-data/` instructions and dispatch to
OpenClaw, and (next) an Agent SDK session instead of the file-based supervisor. It shares no code
with `bridge/` (the file reader is a copy). Until the switch both run side by side: the bridge on
port 8787 behind the tunnel, the factory on 8788; the switch moves the tunnel to the factory and
`bridge/` is deleted afterwards (see `docs/design/SF-011-factory.md`).
