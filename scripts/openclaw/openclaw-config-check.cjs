// Portable check of the live OpenClaw config against config/openclaw/openclaw.json5
// and its named profiles. Runs inside the gateway container (it uses the image's
// json5 package); the host passes the repository files on stdin, separated by NUL:
//
//   { cat config/openclaw/openclaw.json5; printf '\0dashboard\n'; cat config/openclaw/profiles/dashboard.json5; } |
//     docker compose ... exec -T gateway node -e "$(cat scripts/openclaw/openclaw-config-check.cjs)" \
//       /home/node/.openclaw/openclaw.json [offline|dashboard]
//
// Profile "offline" is the repository config itself (SF-004). Every further
// section "<name>\n<json5>" is a profile overlay, deep-merged onto it. The live
// config matches a profile when every setting of that profile is present with
// the same value, and every other live key is runtime metadata that the image
// entrypoint's `doctor --fix` writes on any installation:
//   meta, wizard           objects (migration markers, timestamps, versions)
//   skills.entries.<name>  exactly { enabled: false }
//   agents.entries.<id>    exactly {} (no per-agent model, tools or workspace)
// The optional last argument requires one profile; without it the live config
// must match exactly one profile. Prints only key paths and profile names, never
// values. Exit 0 = pass, 1 = fail, 2 = unreadable input.
const { readFileSync } = require('node:fs');
const JSON5 = require(process.env.SF_JSON5_MODULE || '/app/node_modules/json5');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const everyEntry = (expected) => (value) => isObject(value) && Object.values(value).every((entry) => same(entry, expected));

// Allowed live-only keys, by parent path; the check returns true when the value is acceptable.
const METADATA = {
  '': { meta: isObject, wizard: isObject },
  skills: { entries: everyEntry({ enabled: false }) },
  agents: { entries: everyEntry({}) },
};

function compare(expected, live, path, problems) {
  for (const [key, value] of Object.entries(expected)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in live)) {
      problems.push(`missing ${at}`);
    } else if (isObject(value) && isObject(live[key])) {
      compare(value, live[key], at, problems);
    } else if (!same(value, live[key])) {
      problems.push(`differs ${at}`);
    }
  }
  for (const [key, value] of Object.entries(live)) {
    if (key in expected) {
      continue;
    }
    const at = path ? `${path}.${key}` : key;
    const allowed = (METADATA[path] ?? {})[key];
    if (allowed === undefined) {
      problems.push(`unexpected ${at}`);
    } else if (!allowed(value)) {
      problems.push(`unexpected value at ${at}`);
    }
  }
}

function merge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

const profiles = new Map();
let live;
try {
  const [template, ...overlays] = readFileSync(0, 'utf8').split('\0');
  profiles.set('offline', JSON5.parse(template));
  for (const section of overlays) {
    const newline = section.indexOf('\n');
    profiles.set(section.slice(0, newline).trim(), merge(profiles.get('offline'), JSON5.parse(section.slice(newline + 1))));
  }
  live = JSON5.parse(readFileSync(process.argv[1], 'utf8'));
} catch (error) {
  console.log(`config check: cannot read input (${error.name})`);
  process.exit(2);
}
const required = process.argv[2];
if (required !== undefined && !profiles.has(required)) {
  console.log(`config check: unknown profile ${required}`);
  process.exit(2);
}

const results = new Map();
for (const [name, expected] of profiles) {
  const problems = [];
  if (!isObject(expected) || !isObject(live)) {
    problems.push('config is not an object');
  } else {
    compare(expected, live, '', problems);
  }
  results.set(name, problems);
}
const matching = [...results].filter(([, problems]) => problems.length === 0).map(([name]) => name);
const ok = required === undefined ? matching.length === 1 : matching.includes(required);
if (!ok) {
  for (const name of required === undefined ? [...profiles.keys()] : [required]) {
    for (const problem of results.get(name)) {
      console.log(`config check: [${name}] ${problem}`);
    }
  }
}
console.log(`config check: ${ok ? `ok, profile ${matching.join(',')}` : `no match${required === undefined ? '' : ` for profile ${required}`}`}`);
process.exit(ok ? 0 : 1);
