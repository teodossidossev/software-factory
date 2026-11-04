// The redaction of the reviewers' live events (SF-045): a Codex event of the gate or an SDK message
// of the Claude review loses every environment value, every key and every content from outside the
// worktree (~/.codex above all) before it goes to events.jsonl and the Event stream. One Redactor
// per run: a Claude tool result is withheld by the tool use that asked for it.
import { homedir } from 'node:os';
import { join } from 'node:path';

// What a withheld command output or tool result becomes.
export const WITHHELD = '[withheld: it may hold the environment or a file outside the worktree]';
const REDACTED = '[redacted]';
// The environment variables whose values are not secret, named one by one: every other value is
// redacted, whatever its length (a short one such as "1" or "on" then shows as [redacted:NAME]
// wherever it stands alone, which is why the common ones are listed).
const PUBLIC_NAMES = new Set([
  // The shell, the terminal and the session.
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TMPDIR', 'TMP', 'TEMP',
  'HOSTNAME', 'SHLVL', '_', 'EDITOR', 'VISUAL', 'PAGER', 'LESS', 'MAIL', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'DISPLAY', 'WAYLAND_DISPLAY', 'TZ', 'MANPATH', 'INFOPATH', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  'SSH_AUTH_SOCK', 'DESKTOP_SESSION', 'GDMSESSION', 'SESSION_MANAGER', 'DBUS_SESSION_BUS_ADDRESS', 'VTE_VERSION',
  'GNOME_SHELL_SESSION_MODE', 'GTK_MODULES', 'QT_IM_MODULE', 'GTK_IM_MODULE', 'XMODIFIERS', 'NO_AT_BRIDGE', 'SYSTEMD_EXEC_PID',
  'INVOCATION_ID', 'JOURNAL_STREAM', 'MANAGERPID', 'NODE_ENV',
  // The factory's own settings that hold no secret (SF_NTFY_TOKEN and SF_NTFY_URL stay secret).
  'SF_CHECK_AFTER_FIX_MIN', 'SF_CHECK_AFTER_START_MIN', 'SF_CLAUDE', 'SF_CODEX', 'SF_CODEX_MODEL', 'SF_CONFIG_DIR',
  'SF_DASHBOARD', 'SF_DASHBOARD_PORT', 'SF_DESKTOP_NOTIFY', 'SF_ENV_FILE', 'SF_GATE',
  'SF_GATE_MAX_ROUNDS', 'SF_GATE_MAX_TOKENS', 'SF_GATE_TIMEOUT_MS', 'SF_HANDBOOK', 'SF_MAX_ITERATIONS', 'SF_MAX_JOBS',
  'SF_MAX_TURNS', 'SF_MODEL', 'SF_NOTIFY_ITERATIONS', 'SF_PORT', 'SF_REVIEW', 'SF_REVIEW_MAX_TURNS', 'SF_REVIEW_MODEL',
  'SF_SANDBOX', 'SF_SANDBOX_DOMAINS', 'SF_SENSITIVE_PATHS', 'SF_STATE_DIR', 'SF_TUNNEL_HEALTH', 'SF_TUNNEL_SCRIPT',
  'SF_WORKTREE_ROOT',
]);
// LC_*, XDG_* and npm's package and lifecycle metadata (npm_config_* may hold a registry token).
const PUBLIC_PREFIX = /^(?:LC_|XDG_|npm_package_|npm_lifecycle_)/;
const PUBLIC_NPM = new Set(['npm_command', 'npm_execpath', 'npm_node_execpath', 'npm_config_user_agent']);

// The words that end the name of a field or variable that holds a key.
const KEY_WORDS = 'key|token|secret|password|passwd|credentials?';
// A quoted value, escaped quotes included.
const QUOTED = `"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'`;

// Keys by their form, each replaced as a whole (the replacement keeps what precedes the key).
const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
  // An HTTP credential: the scheme word, then a token with a digit or a base64 sign (not prose).
  [/\b(Bearer|Basic)\s+(?=[A-Za-z._~-]*[0-9+/=])[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${REDACTED}@`],
  // NAME=value and NAME: value in the environment's and dotenv's style: an upper-case name that
  // ends with a key word (OPENAI_API_KEY, DB_PASSWORD; not MAX_TOKENS or KEY_NAME).
  [new RegExp(`(\\b[A-Z][A-Z0-9_]*(?:${KEY_WORDS.toUpperCase()})\\b\\s*[=:]\\s*)(?:${QUOTED}|[^\\s"']+)`, 'g'), `$1${REDACTED}`],
  // "access_token": "value" (JSON) and access_token = "value" (TOML, INI): a name that is a key
  // word or ends with one after _ - or . (api_key, client-secret; not monkey).
  [new RegExp(`((?:"(?:[^"\\n]*[_.-])?(?:${KEY_WORDS})"|\\b(?:[\\w-]*[_.-])?(?:${KEY_WORDS}))\\s*[:=]\\s*)(?:${QUOTED})`, 'gi'), `$1"${REDACTED}"`],
  // The same in camelCase: "apiKey": "value", clientSecret = 'value'.
  [new RegExp(`((?:"[^"\\n]*[a-z0-9](?:Key|Token|Secret|Password|Credentials?)"|\\b[a-z][\\w]*[a-z0-9](?:Key|Token|Secret|Password|Credentials?))\\s*[:=]\\s*)(?:${QUOTED})`, 'g'), `$1"${REDACTED}"`],
];

// A shell wrapper around Codex's command: bash -lc '…'.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+/;
// A command that prints the environment: env or printenv (also by a path), or export, declare,
// typeset or set without an assignment.
const COMMAND_START = `(?:^|[;&|(\`'"\\n]|\\$\\()\\s*(?:(?:sudo|command|exec|time|nohup|xargs)\\s+)*`;
const ENV_DUMP = new RegExp([
  `${COMMAND_START}(?:\\S*\\/)?(?:env|printenv)(?=$|[\\s;&|)\`'"])`,
  `${COMMAND_START}(?:export|declare|typeset)(?=\\s*(?:$|[;&|)\`'"]|-[px]))`,
  `${COMMAND_START}set(?=\\s*(?:$|[;&|)\`'"]))`,
].join('|'));
// Code that reads the environment: os.environ, process.env, getenv, %ENV, $ENV, ENV[…].
const ENV_READ = /\bos\.environ\b|\bprocess\.env\b|\bgetenv\b|%ENV\b|\$ENV\b|\bENV\[|\/environ\b/;
// A path that reaches outside the worktree: the home (~, $HOME), a parent (..), ~/.codex however
// it is spelled. Absolute paths are checked against the worktree on their own.
const OUTSIDE = /(?:^|[\s'"=:(<>])~|\$\{?(?:HOME|CODEX_HOME|USERPROFILE)\b|(?:^|[\s'"=/])\.\.(?:\/|$|[\s'"])|CODEX_HOME/;
// A command that goes to the home: cd or pushd without a directory.
const CD_HOME = /(?:^|[;&|(]\s*)(?:cd|pushd)\s*(?=$|[;&|)])/;
// An interpreter that can print what ENV_READ names (rg "process.env" only searches for it).
const INTERPRETER = /(?:^|[\s;&|(`'"/])(?:python[0-9.]*|node|deno|bun|ruby|perl|php|awk|gawk)(?=$|[\s;&|)`'"])/;
// A file in a dot directory of the home, or in $CODEX_HOME, named the short way: ~/.codex/config.toml.
const HOME_FILE_MENTION = /(?:~|\$\{?HOME\}?)\/\.[\w.-]+\/[\w.-]|\$\{?CODEX_HOME\}?\/[\w.-]/;
const ABSOLUTE_PATH = /(?:^|[\s'"=:(<>|,[{])(\/[^\s'"`;&|)<>,\]}]*)/g;
// A character that ends a path in an output: whitespace, a separator or a closing bracket.
const PATH_END = /[\s:'"`,;)\]}>|]/;
const DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);
// A shell reference to a variable: $NAME or ${NAME.
const VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const KEY_NAME = new RegExp(`(?:${KEY_WORDS})`, 'i');
// Lines in the shape of an environment dump (NAME=value, export NAME=…, declare -x NAME=…); this
// many of them withhold an output.
const ENV_LINE = /^(?:(?:declare -x|export)\s+)?[A-Za-z_][A-Za-z0-9_]*=/gm;
const ENV_LINES = 3;
// The fields of a Codex event or an SDK message the protocol sets, never content: kept as they are.
const STRUCTURAL_FIELDS = new Set(['type', 'subtype', 'role', 'id', 'tool_use_id', 'parent_tool_use_id', 'uuid', 'session_id', 'thread_id', 'status', 'stop_reason']);
// The string fields kept once a run is marked: the protocol's, Codex's command lines and the
// review's tool names. Every other string becomes WITHHELD; numbers (exit codes, tokens) stay.
const CODEX_KEPT = new Set([...STRUCTURAL_FIELDS, 'command']);
const REVIEW_KEPT = new Set([...STRUCTURAL_FIELDS, 'name']);
// The fields of a review tool use that name a path (Grep's pattern is a regex, not a path).
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface RedactorOptions {
  // The job's worktree: what a reviewer may read.
  cwd: string;
  // The environment whose values are secret; default the factory's (a superset of the reviewers').
  env?: NodeJS.ProcessEnv;
  // The user's home; default os.homedir().
  home?: string;
}

export class Redactor {
  readonly #cwd: string;
  readonly #home: string;
  readonly #codexHome: string;
  // The secret environment values and their names; one pattern of them, longest first.
  readonly #values = new Map<string, string>();
  readonly #names: Set<string>;
  readonly #valuePattern: RegExp | undefined;
  // The ids of the review's tool uses whose results are withheld.
  readonly #withheld = new Set<string>();
  // Set once the run has read something withheld: its prose from then on is withheld too.
  #tainted = false;

  constructor(options: RedactorOptions) {
    const env = options.env ?? process.env;
    this.#cwd = options.cwd.replace(/\/+$/, '');
    this.#home = (options.home ?? homedir()).replace(/\/+$/, '');
    this.#codexHome = env.CODEX_HOME || join(this.#home, '.codex');
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined || value === '' || PUBLIC_NAMES.has(name) || PUBLIC_NPM.has(name) || PUBLIC_PREFIX.test(name) || this.#values.has(value)) {
        continue;
      }
      this.#values.set(value, name);
    }
    this.#names = new Set(this.#values.values());
    const values = [...this.#values.keys()].sort((a, b) => b.length - a.length);
    this.#valuePattern = values.length > 0 ? new RegExp(`(?<![A-Za-z0-9])(?:${values.map(escape).join('|')})(?![A-Za-z0-9])`, 'g') : undefined;
  }

  // A string without environment values and keys.
  text(text: string): string {
    let result = this.#valuePattern !== undefined ? text.replace(this.#valuePattern, (value) => `[redacted:${this.#values.get(value)}]`) : text;
    for (const [pattern, replacement] of KEY_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  // A failure message of the run (a failed review or gate: its record, its review_failed line and
  // the job's error), withheld like reviewer prose: the factory's lead-in up to the first ": "
  // stays, redacted; the detail after it (Codex's error or stderr, the review's errors) is withheld
  // when it shows or names a home file or the run has read something withheld. A message without
  // a lead-in is withheld whole when it shows or names a home file.
  failure(message: string): string {
    const cut = message.indexOf(': ');
    const head = cut >= 0 ? message.slice(0, cut + 2) : message;
    const detail = cut >= 0 ? message.slice(cut + 2) : '';
    if (this.#revealingOutput(head)) {
      return WITHHELD;
    }
    if (detail !== '' && (this.#tainted || this.#revealingOutput(detail))) {
      return `${this.text(head)}${WITHHELD}`;
    }
    return this.text(message);
  }

  // A value with every string in it redacted; object keys stay, and so do the fields that
  // structure an event or a message (its type, role and ids), which the protocol sets.
  #deep(value: unknown): unknown {
    if (typeof value === 'string') {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.#deep(entry));
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, STRUCTURAL_FIELDS.has(key) && typeof entry === 'string' ? entry : this.#deep(entry)]));
    }
    return value;
  }

  // Text that names a path outside the worktree: the home, a parent, ~/.codex, /proc, or any
  // absolute path that is not the worktree's or a standard device.
  #reachesOutside(text: string): boolean {
    if (OUTSIDE.test(text) || text.includes(this.#codexHome)) {
      return true;
    }
    return [...text.matchAll(ABSOLUTE_PATH)].some(([, path]) => {
      const clean = path!.replace(/\/+$/, '') || '/';
      return !(this.#inWorktree(clean, 0) || DEVICES.has(clean));
    });
  }

  // Whether the text at index starts with the worktree's path as a whole path: the worktree or a
  // path under it that does not climb out with "..", not a sibling whose name only starts the same.
  // Without a worktree, nothing is.
  #inWorktree(text: string, index: number): boolean {
    if (this.#cwd === '' || !text.startsWith(this.#cwd, index)) {
      return false;
    }
    const rest = text.slice(index + this.#cwd.length);
    if (rest === '' || PATH_END.test(rest.charAt(0))) {
      return true;
    }
    if (!rest.startsWith('/')) {
      return false;
    }
    const path = rest.split(PATH_END, 1)[0]!;
    return !/\/\.\.(?:\/|$)/.test(path);
  }

  // A command whose output may hold the environment or a file outside the worktree.
  #revealingCommand(command: string): boolean {
    const inner = command.replace(SHELL_WRAPPER, '');
    if (ENV_DUMP.test(inner) || (ENV_READ.test(inner) && INTERPRETER.test(inner)) || CD_HOME.test(inner) || this.#reachesOutside(inner)) {
      return true;
    }
    return [...inner.matchAll(VARIABLE)].some(([, name]) => this.#names.has(name!) || KEY_NAME.test(name!));
  }

  // An output that shows a file of ~/.codex or another dotfile of the home by its absolute path (the
  // worktree's own paths aside: by default it lives under ~/.local/state), or an environment dump:
  // what a read outside the worktree prints. It withholds the output and marks the run.
  #showsHomeFile(text: string): boolean {
    return text.includes(this.#codexHome) || this.#showsHomeDotfile(text) || (text.match(ENV_LINE)?.length ?? 0) >= ENV_LINES;
  }

  // Text that shows such a file, or names one the short way (~/.codex/config.toml): withheld.
  #revealingOutput(text: string): boolean {
    return this.#showsHomeFile(text) || HOME_FILE_MENTION.test(text);
  }

  // Whether the text names a path under a dot directory of the home that is not the worktree's.
  #showsHomeDotfile(text: string): boolean {
    const dotted = `${this.#home}/.`;
    for (let index = text.indexOf(dotted); index >= 0; index = text.indexOf(dotted, index + 1)) {
      if (!this.#inWorktree(text, index)) {
        return true;
      }
    }
    return false;
  }

  // Reviewer prose (a message, reasoning, thinking, a result): withheld when it shows a file of
  // ~/.codex or another dotfile of the home, or once the run has read something withheld (prose
  // may repeat it without naming it); else redacted.
  #prose(original: string, redacted: string): string {
    return this.#tainted || this.#revealingOutput(original) ? WITHHELD : redacted;
  }

  // A value withheld when the run is marked or its JSON reveals a home file; else as redacted.
  #guarded(original: unknown, redacted: unknown): unknown {
    return this.#tainted || this.#revealingOutput(JSON.stringify(original) ?? '') ? WITHHELD : redacted;
  }

  // A value with every string withheld but those under a kept field (of any depth); numbers,
  // booleans and null stay. The content of a marked run.
  #scrub(value: unknown, kept: Set<string>, key = ''): unknown {
    if (typeof value === 'string') {
      return kept.has(key) ? value : WITHHELD;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.#scrub(entry, kept, key));
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, this.#scrub(entry, kept, field)]));
    }
    return value;
  }

  // A Codex event of the gate, redacted (#codexEventOf); once the run is marked, every string of
  // it but the kept fields (CODEX_KEPT) is withheld.
  codexEvent(event: unknown): unknown {
    const marked = this.#tainted;
    const redacted = this.#codexEventOf(event);
    return marked ? this.#scrub(redacted, CODEX_KEPT) : redacted;
  }

  // A Codex event of the gate, redacted: the output of a revealing command (or one that reveals
  // itself) is withheld and marks the run, and so is the result of an MCP tool call; prose as
  // #prose says; an error message, MCP arguments and errors when they reveal a home file.
  #codexEventOf(event: unknown): unknown {
    const redacted = this.#deep(event);
    if (!isObject(event) || !isObject(redacted)) {
      return redacted;
    }
    if (typeof event.message === 'string' && this.#revealingOutput(event.message)) {
      redacted.message = WITHHELD;
    }
    if (isObject(event.error) && isObject(redacted.error) && typeof event.error.message === 'string' && this.#revealingOutput(event.error.message)) {
      redacted.error = { ...redacted.error, message: WITHHELD };
    }
    const item = isObject(event.item) ? event.item : undefined;
    if (item === undefined || !isObject(redacted.item)) {
      return redacted;
    }
    const copy = redacted.item;
    if (item.type === 'command_execution') {
      const command = Array.isArray(item.command) ? item.command.map(String).join(' ') : String(item.command ?? '');
      const output = String(item.aggregated_output ?? '');
      if (this.#revealingCommand(command) || this.#showsHomeFile(output)) {
        this.#tainted = true;
      }
      if ('aggregated_output' in item && (this.#revealingCommand(command) || this.#revealingOutput(output))) {
        redacted.item = { ...copy, aggregated_output: WITHHELD };
      }
    } else if (item.type === 'mcp_tool_call') {
      if ('result' in item && item.result !== null && item.result !== undefined) {
        this.#tainted = true;
      }
      redacted.item = {
        ...copy,
        ...('result' in item ? { result: WITHHELD } : {}),
        ...('arguments' in item ? { arguments: this.#guarded(item.arguments, copy.arguments) } : {}),
        ...('error' in item && item.error !== null ? { error: this.#revealingOutput(JSON.stringify(item.error) ?? '') ? WITHHELD : copy.error } : {}),
      };
    } else if ((item.type === 'agent_message' || item.type === 'reasoning') && typeof item.text === 'string') {
      redacted.item = { ...copy, text: this.#prose(item.text, String(copy.text)) };
    } else if (item.type === 'todo_list' && Array.isArray(item.items) && Array.isArray(copy.items)) {
      const copies = copy.items as unknown[];
      redacted.item = { ...copy, items: item.items.map((entry: unknown, index: number) => {
        const target = copies[index];
        return isObject(entry) && isObject(target) && typeof entry.text === 'string' ? { ...target, text: this.#prose(entry.text, String(target.text)) } : target;
      }) };
    } else if (item.type === 'error' && typeof item.message === 'string' && this.#revealingOutput(item.message)) {
      redacted.item = { ...copy, message: WITHHELD };
    }
    return redacted;
  }

  // Whether a review tool use reaches outside the worktree: a path field (or Glob's pattern) that
  // names one.
  #revealingToolUse(name: unknown, input: unknown): boolean {
    const fields = isObject(input) ? input : {};
    const paths = [...PATH_FIELDS, ...(name === 'Glob' ? ['pattern'] : [])].map((key) => fields[key]).filter((value) => typeof value === 'string');
    return paths.some((path) => this.#reachesOutside(path) || ENV_READ.test(path));
  }

  // An SDK message of the Claude review, redacted (#reviewMessageOf); once the run is marked, every
  // string but the kept fields (REVIEW_KEPT) is withheld: in each content block after the mark,
  // and in the rest of the message when the mark came before its end.
  reviewMessage(message: unknown): unknown {
    const redacted = this.#reviewMessageOf(message);
    if (!this.#tainted || !isObject(redacted)) {
      return redacted;
    }
    const content = isObject(redacted.message) ? redacted.message.content : undefined;
    const scrubbed = this.#scrub(redacted, REVIEW_KEPT) as Record<string, unknown>;
    if (content !== undefined && isObject(scrubbed.message)) {
      scrubbed.message = { ...scrubbed.message, content };
    }
    return scrubbed;
  }

  // An SDK message of the Claude review, redacted: the result of a tool use that reaches outside
  // the worktree, or that reveals itself, is withheld; each block after the run's mark scrubbed.
  #reviewMessageOf(message: unknown): unknown {
    const redacted = this.#deep(message);
    if (!isObject(message) || !isObject(redacted)) {
      return redacted;
    }
    if (message.type === 'result') {
      if (typeof message.result === 'string') {
        redacted.result = this.#prose(message.result, String(redacted.result));
      }
      if (Array.isArray(message.errors) && Array.isArray(redacted.errors)) {
        const copies = redacted.errors as unknown[];
        redacted.errors = message.errors.map((error: unknown, index: number) => (typeof error === 'string' ? this.#prose(error, String(copies[index])) : copies[index]));
      }
      if (message.structured_output !== undefined && message.structured_output !== null) {
        redacted.structured_output = this.#guarded(message.structured_output, redacted.structured_output);
      }
    }
    if (!isObject(message.message) || !Array.isArray(message.message.content) || !isObject(redacted.message)) {
      return redacted;
    }
    const copies = redacted.message.content as unknown[];
    let withheld = false;
    // In order: a block's prose is judged after the blocks before it (text before a read stays).
    const blocks = message.message.content.map((block: unknown, index: number) => {
      const marked = this.#tainted;
      const done = this.#reviewBlock(block, copies[index], () => {
        withheld = true;
      });
      return marked ? this.#scrub(done, REVIEW_KEPT) : done;
    });
    return {
      ...redacted,
      message: { ...redacted.message, content: blocks },
      ...(withheld && 'tool_use_result' in redacted ? { tool_use_result: WITHHELD } : {}),
    };
  }

  // One content block of a review message, redacted: a tool use that reaches outside marks the
  // run, prose and other tool inputs as #prose and #guarded say, a revealing tool result withheld
  // (onWithheld: so is the message's tool_use_result).
  #reviewBlock(block: unknown, copy: unknown, onWithheld: () => void): unknown {
    const original = isObject(block) ? block : {};
    if (!isObject(copy)) {
      return copy;
    }
    if (original.type === 'tool_use' && typeof original.id === 'string' && this.#revealingToolUse(original.name, original.input)) {
      this.#withheld.add(original.id);
      this.#tainted = true;
      return copy;
    }
    // Read's and Glob's inputs are paths, checked above; any other input (Grep's pattern, the
    // structured verdict) may repeat what the run read.
    if (original.type === 'tool_use' && original.name !== 'Read' && original.name !== 'Glob' && 'input' in original) {
      return { ...copy, input: this.#guarded(original.input, copy.input) };
    }
    if (original.type === 'text' && typeof original.text === 'string') {
      return { ...copy, text: this.#prose(original.text, String(copy.text)) };
    }
    if (original.type === 'thinking' && typeof original.thinking === 'string') {
      return { ...copy, thinking: this.#prose(original.thinking, String(copy.thinking)) };
    }
    if (original.type !== 'tool_result') {
      return copy;
    }
    const content = JSON.stringify(original.content ?? '');
    const reads = (typeof original.tool_use_id === 'string' && this.#withheld.has(original.tool_use_id)) || this.#showsHomeFile(content);
    if (reads) {
      this.#tainted = true;
    }
    if (!reads && !this.#revealingOutput(content)) {
      return copy;
    }
    onWithheld();
    return { ...copy, content: WITHHELD };
  }
}
