# CLI configuration diagnostics

**Status: Proposed.** Design sign-off is pending. Do not implement this
spec until the design is approved, and do not start an implementation card
until the security-review questions below have a recorded disposition.
This document is the single source of truth for the proposed contract;
the command help and the CLI guide will point here rather than restate it.

## Problem

Before asking for credentials or publishing to the wrong origin, an agent
should be able to answer three questions offline: which configuration
source actually wins, whether each source is absent, valid, malformed or
unreadable, and what to do next. Today it cannot:

- `packages/cli/src/main.ts` (`resolveInstance`) implements a real
  precedence chain (`--api` flag, then `KOFRA_API`/`KOFRA_URL`, then
  `./dropway.json`, then the saved default instance; `--key`, then
  `KOFRA_API_KEY`, then the saved key), but no command shows the outcome.
- `packages/cli/src/config.ts` (`readCredentials`, `readLink`) collapses
  missing, unreadable and malformed files into the same absent value, so
  a corrupt file looks exactly like a fresh machine.
- The existing config tests (`packages/cli/test/unit.test.ts`, "config")
  cover storage round-trips and path mapping, not diagnostic provenance
  or redaction.

The fix proposed here is a strictly offline, read-only `explain-config`
command that reports the effective configuration and every source's
state, with credentials and other sensitive values redacted by
construction.

## Non-goals

- No change to resolver behavior. `readCredentials` and `readLink` keep
  collapsing malformed input exactly as today; a corrupt file looking
  "absent" to the resolver is existing compatibility, and this spec must
  not be read as permission to change it. The diagnostic is a separate
  read path that classifies what the resolver collapses.
- No repair, no writes, no network, no token validation, no login, no
  rotation, no telemetry, no probes. See "Offline and read-only".
- No new server API, no scope or policy change, no hosted concepts.

## Command (normative for the implementation PR)

```
kofra explain-config [path] [--api <url>] [--key <key>] [--json] [-q]
```

- `explain-config` takes the same global `--api` / `--key` flags as every
  command, because those flags *are* precedence inputs under diagnosis:
  `kofra explain-config --api <url>` shows how that value would win.
  No new flags. No alias.
- The optional `[path]` is a publish path as accepted by
  `kofra publish <path>`. When given, the output reports the single
  mapping lookup for that path (found slug, or missing). The command
  never enumerates the stored mappings.
- The command never prompts and never reads stdin, even on a terminal.
- Future help line (one line, from the command table as usual):
  `explain-config`: "Show which configuration wins, without contacting
  anything". Future guide row: `explain-config [path]` — "Diagnose local
  configuration offline: winning sources, file states, redacted".

## Resolution model

### Sources and precedence

API origin, highest precedence first:

| # | Kind | Detail (closed set) |
|---|------|---------------------|
| 1 | `flag` | `--api` |
| 2 | `env` | `KOFRA_API`, `KOFRA_URL` (each possibly filled from its `DROPWAY_*` legacy twin; see below) |
| 3 | `project` | `./dropway.json` field `api` |
| 4 | `default` | saved default instance in `credentials.json` |

Key, highest precedence first:

| # | Kind | Detail (closed set) |
|---|------|---------------------|
| 1 | `flag` | `--key` |
| 2 | `env` | `KOFRA_API_KEY` (possibly filled from `DROPWAY_API_KEY`) |
| 3 | `saved` | `credentials.json` entry for the effective API origin |

Rules:

- Selection is positional, not by validity: the first *present* source
  wins, exactly as the resolver does today. A present-but-invalid API
  value fails resolution with `invalid_api_url`; lower sources are
  reported as shadowed, never consulted, and their values are not
  validated. This mirrors `resolveInstance`, which normalizes the first
  present value and throws.
- Empty string is absent everywhere (matches the resolver's `||`
  chaining and the legacy merge below).
- Legacy names: `DROPWAY_*` fills an unset or empty `KOFRA_*` twin
  (`withLegacyEnv` in `packages/cli/src/legacy-brand.ts`). The output
  names the literal winning variable and sets `viaLegacyName: true`
  when the value arrived through a `DROPWAY_*` twin. When both twins
  are set, `KOFRA_*` wins and the legacy twin is reported shadowed.
- Saved-key lookup is keyed by the effective API origin. A malformed or
  unreadable credentials file therefore yields "no saved key", exactly
  as the resolver behaves; the file's own state is reported separately.

### States

File sources (`credentials.json`, `./dropway.json`) are always examined
and classified as one of:

- `absent`: the file does not exist.
- `valid`: readable, parses, and has the expected shape.
- `malformed`: parses as the wrong thing (`invalid_json`, or valid JSON
  whose top-level value or known fields have the wrong type:
  `invalid_shape`). Classification only; the resolver keeps treating
  these as absent.
- `unreadable`: exists but cannot be read (`permission` for
  `EACCES`/`EPERM`, `not_a_file` for `EISDIR` and friends, `io_error`
  otherwise). Closed enum; no `strerror` text is emitted.

Value sources (flag, env, `link.api`, saved default) classify as:

- `absent`: unset or empty.
- `valid`: present and accepted (API values must pass origin
  normalization; any non-empty key counts as present — key format is
  not validated offline).
- `invalid`: present but rejected (API values that fail normalization).
  The rejected input is never echoed.

## JSON contract

With `--json` the command prints exactly one JSON object on stdout (the
usual CLI envelope rules apply) and nothing else there. The data
envelope is used for every parsed invocation, including unconfigured
and missing-key outcomes; only argument-parsing failures keep the
standard error envelope. The JSON shape is normative; the human text is
illustrative but bound by the same redaction rules.

```jsonc
{
  "schema": "kofra.explain-config/v1",
  "ok": true,                        // exitCode === 0
  "status": "ready",                  // ready | needs_key | unconfigured
  "exitCode": 0,
  "api": {
    "origin": "https://dropway.example.workers.dev",  // normalized origin, or null
    "source": { "kind": "env", "detail": "KOFRA_API", "viaLegacyName": false }  // or null
  },
  "key": {
    "present": true,
    "source": { "kind": "saved" },    // flag | env | saved | null
    "kind": "api_key"                 // api_key (dw_…) | claim_token (dwc_…) | other | null
  },
  "configDir": { "selector": "default", "path": "~/.config/dropway" },
  "credentialsFile": {
    "state": "valid", "detail": null,
    "defaultPresent": true, "instanceCount": 2,
    "hasEntryForEffectiveApi": true
  },
  "projectLink": {
    "state": "valid", "detail": null,
    "apiMatchesEffective": true, "sitesEntryCount": 1,
    "mapping": { "key": "dist", "slug": "bright-otter-x7k2" }  // or {key,slug:null}, or null without [path]
  },
  "checks": [
    { "id": "api.selected", "severity": "info", "code": "source_selected",
      "hint": "…", "nextAction": null, "source": { "kind": "env", "detail": "KOFRA_API" } }
  ]
}
```

Field rules:

- `schema` is `kofra.explain-config/v1`. Version 1 only ever gains new
  check IDs and new nullable fields; consumers must ignore unknown
  check IDs. Any breaking change ships as a new schema string.
- `source.detail` for flags is the literal flag (`--api`, `--key`); for
  env it is the literal variable name from the closed set above; for
  `project`, `default` and `saved` it is `null`.
- `configDir.selector` is one of `KOFRA_CONFIG_DIR`, `XDG_CONFIG_HOME`,
  `APPDATA`, `default`, matching `configDir()` precedence.
- Every string is capped at 1024 characters; longer values are cut with
  a `[…truncated]` marker. `checks` holds at most 32 entries (the
  closed ID set below cannot reach that; the cap is a backstop).
- Output is deterministic: the same filesystem, environment, argv and
  working directory produce byte-identical stdout. No timestamps, no
  `savedAt`, no random ordering; checks appear in the table order below.

### Checks (closed ID set)

Every check carries a stable `id`, a `severity` (`info`, `warning`,
`error`), a stable snake_case `code`, a `hint` and either a
`nextAction` command template (angle-bracket placeholders only, never
real values) or `null`. Hints and templates contain no caller values.

| ID | Severity | Code | When | `nextAction` template |
|----|----------|------|------|-----------------------|
| `api.selected` | info | `source_selected` | an API source won | null |
| `api.unconfigured` | error | `no_instance` | no API source present | `kofra login --api https://<your-instance>` |
| `api.invalid_value` | error | `invalid_api_url` | the winning value failed normalization | `Pass --api https://<your-instance>.` |
| `api.value_trimmed` | info | `input_trimmed` | normalization dropped `userinfo`, `path`, `query` or `fragment` (listed in `removed`) | `Use the bare origin https://<host>.` |
| `api.source_shadowed` | info | `source_shadowed` | a lower source was set but not consulted | null |
| `key.selected` | info | `source_selected` | a key source won | null |
| `key.absent` | error | `not_logged_in` | API resolved but no key selected | `kofra login --api <effective-origin>` |
| `key.kind_noted` | info | `key_kind` | selected key kind is `claim_token` or `other` | null |
| `credentials_file.malformed` | error | `malformed_credentials` | see States (`detail` set) | `kofra login --api https://<your-instance>` (rewrites the file) |
| `credentials_file.unreadable` | error | `unreadable_credentials` | see States (`detail` set) | `Check the permissions of <path>.` |
| `project_link.malformed` | error | `malformed_project_link` | see States (`detail` set) | `Delete or fix ./dropway.json.` |
| `project_link.unreadable` | error | `unreadable_project_link` | see States (`detail` set) | `Check the permissions of ./dropway.json.` |
| `project_link.foreign_instance` | warning | `foreign_project_link` | link `api` is valid but differs from the effective origin, so its mappings are ignored | `Publish once with --api <effective-origin> --new, or remove ./dropway.json.` |
| `project_link.mapping_missing` | info | `mapping_missing` | `[path]` given and the link has no entry for it | null |
| `project_link.mapping_found` | info | `mapping_found` | `[path]` given and an entry exists | null |
| `env.legacy_shadowed` | info | `source_shadowed` | a `DROPWAY_*` twin was set but its `KOFRA_*` twin won | null |

Severity notes:

- The exit code derives only from the effective outcome (see below), so
  a corrupt credentials file is an `error` check even when flags shadow
  it: always worth fixing, never silently ignored. Agents that want
  strictness fail on any `error` check in JSON.
- `key.absent` is how anonymous-capable flows see the world too: key
  absence is configuration data, and callers that publish with
  `--anonymous` ignore exit 3 deliberately.

## Redaction (normative)

The output is built from allowlisted fields only; raw caller inputs are
never echoed. In particular:

- Never emit key material: no flag, env or saved key values, no
  fingerprints, no lengths. Key presence, source kind and the
  `dw_`/`dwc_` prefix-derived kind are the only key facts.
- Never emit file contents: neither file's bytes, in whole or part,
  appear in any field, hint or message.
- Origins are normalized with origin semantics (scheme plus host plus
  port; userinfo, path, query and fragment are dropped) and invalid
  inputs are described by code only. Only normalized credential-free
  origins and source kinds appear.
- Never emit token-shaped substrings anywhere in stdout or stderr. The
  implementation reuses the existing credential-pattern list
  (`SECRET_PATTERNS` in `packages/cli/src/secrets.ts`, which already
  reports kind and location, never values) as the verification sweep:
  the future test asserts that no pattern matches any output byte.
- Paths are emitted with the home directory collapsed to `~` (user
  profile on Windows), so diagnostics pasted into tickets do not leak
  usernames. Precedent commands print raw paths; this command is held
  to the safer form because its output is meant to be shared.
- Stored mapping keys are never enumerated: only the count and, with
  `[path]`, the single caller-provided lookup. Mapping keys can name
  private folders; the caller already knows the path they asked about.
- No headers, no copied environment values, no proposed secrets. Only
  the closed variable-name set above is named, never its values.
- Human text obeys the same rules: it must contain no value the JSON
  contract forbids.

Fixture rule for tests: fixtures are synthetic values generated for the
test (for example `dw_test_…` canaries that match the real prefixes).
Never use a real credential, and assert each canary is absent from the
output bytes.

## Offline and read-only (normative)

The implementation must satisfy all of these, and the future tests pin
each one with a sentinel:

- No `fetch`, no `XMLHttpRequest`, no `node:http/https/net/dns/tls`
  imports; no `Request` construction aimed at the network. The command
  must exit identically with the network namespace removed.
- No writes: no `writeFile`, `mkdir`, `chmod`, `rename`, `rm`,
  `appendFile` or `copyFile` on any path, including the config dir and
  the project link. Repair is explicitly out of scope: the command
  suggests `nextAction` commands, never runs them.
- No token validation, login, rotation, provider calls or telemetry.
  Key "validity" is presence plus prefix kind only.
- No `prompt`, no `readStdin`, no `stdin` reads at all; the only inputs
  are argv, `process.env`, the working directory and the two config
  files (plus `stat` on their containing directories as needed to
  classify states).
- Filesystem reads are limited to the config file, the project link and
  the minimum directory stats to classify them. Symlinks are followed
  exactly as the resolver follows them today (no new traversal logic);
  the security questions below ask whether that needs narrowing.

## Exit semantics (deterministic)

| Exit | `status` | Meaning |
|------|----------|---------|
| 0 | `ready` | an API origin resolved and a key was selected |
| 3 | `needs_key` | an API origin resolved, no key selected |
| 2 | `unconfigured` | no API origin resolved, or argv failed to parse |
| 1 | — | unexpected internal failure only; never a diagnosed state |

Exits 4–8 are unreachable: there is no server contact. The `exitCode`
is echoed in JSON so piped output stays interpretable.

## Human output (illustrative)

```
Instance: https://dropway.example.workers.dev (from KOFRA_API)
Key: saved api_key
Config: ~/.config/dropway/credentials.json ok; ./dropway.json ok (1 mapping)
```

One line per warning/error check follows (`code`: hint). Exact wording
is illustrative; the redaction rules and the JSON contract are
normative.

## Discovery

- `kofra help` gains the one line quoted under Command; `kofra help
  explain-config` renders the usage plus the global footer, as usual.
- The CLI guide gains the one table row quoted under Command.
- This document stays the only full description. The generated agent
  skill is not hand-edited for this; if skill generation picks up new
  commands automatically, that output must link here, not copy the
  schema.
- The check an agent runs: `kofra explain-config --json` and branch on
  `exitCode` / `status` / `checks[].severity`. Zero means "a following
  authenticated command has what it needs"; anything else names the
  blocker and the fix.

## Future acceptance matrix

For the paired Test Author. Each row is a hermetic fixture (synthetic
config dir via `KOFRA_CONFIG_DIR`, synthetic cwd, controlled env):

| # | Case | Expect |
|---|------|--------|
| 1 | `--api` set plus env, link and default | exit per key state; `api.selected` source `flag`; one `api.source_shadowed` per lower set source |
| 2 | `KOFRA_API` plus `KOFRA_URL` | `KOFRA_API` wins; `KOFRA_URL` shadowed |
| 3 | only `DROPWAY_API` set | wins with `viaLegacyName: true` |
| 4 | `KOFRA_API` plus `DROPWAY_API` | `KOFRA_API` wins; `env.legacy_shadowed` info |
| 5 | empty-string env values | treated as absent |
| 6 | link `api` plus saved default | link wins; default shadowed |
| 7 | valid link `api` differing from effective origin | `project_link.foreign_instance` warning; mappings ignored |
| 8 | nothing set anywhere | exit 2, `status: unconfigured`, `api.unconfigured` error |
| 9 | winning `--api` invalid, valid env present | exit 2 `invalid_api_url` on the flag; env shadowed, not consulted |
| 10 | `credentials.json` with invalid JSON | `credentials_file.malformed` (`invalid_json`); key falls through; exit follows the effective outcome |
| 11 | `credentials.json` valid JSON, wrong shape | `malformed` with `invalid_shape` (resolver behavior unchanged) |
| 12 | credentials path is a directory | `unreadable` with `not_a_file` |
| 13 | `dropway.json` malformed / unreadable | matching `project_link.*` error checks |
| 14 | key precedence flag over env over saved; kinds `dw_` / `dwc_` / other | `key.selected` with the right source and kind; `key.kind_noted` for non-`dw_` |
| 15 | API resolved, no key anywhere | exit 3, `status: needs_key`, `key.absent` error |
| 16 | credential-shaped canaries planted in both files | no `SECRET_PATTERNS` match in any output byte; canary substrings absent |
| 17 | `--api` with userinfo, path, query, fragment | origin emitted; `api.value_trimmed` lists each removed part; no input echo |
| 18 | hostile schemes (`javascript:`, `ftp:`, `file:`), control characters | `invalid`, exit 2 |
| 19 | 8 KB URL, unicode/IDN host, padded whitespace | bounded output (≤1024 chars per string, truncation marker); normalized origin |
| 20 | `[path]` with and without a stored entry | `mapping_found` with slug / `mapping_missing`; planted foreign keys never appear |
| 21 | no `[path]` | `mapping` is null; `sitesEntryCount` only |
| 22 | zero-network sentinel: `fetch` sabotaged to throw, DNS removed | identical exit and stdout |
| 23 | zero-write sentinel: fixture tree hashed before and after | identical hashes and mtimes |
| 24 | determinism: two consecutive runs | byte-identical stdout; no `savedAt`, no timestamps |
| 25 | no-prompt: stdin closed, stdout piped | exits promptly; stderr carries no prompt |
| 26 | JSON conformance | parses; `schema` exact; `checks` within bounds and ID set; unknown IDs ignored by the consumer test |

## Security-review questions

Explicit questions for the security disposition that must precede any
implementation:

1. Is `~`-collapsed path emission acceptable in a shareable diagnostic,
   or must paths be omitted entirely (selector only)?
2. Is the `removed: ["userinfo"]` presence signal acceptable? It
   confirms the caller's input contained credential-bearing URL parts
   without emitting them, and nudges rotation of shell history and env.
3. Is prefix-derived key kind (`api_key` / `claim_token` / `other`)
   acceptable output, given real keys stay in memory only?
4. The diagnostic loads the credentials file into memory (as the
   resolver already does) but serializes none of it. Is that handling
   acceptable, or should the key-source check avoid parsing key values
   at all (for example, presence by shape without retaining values)?
5. Symlink following matches the resolver exactly. Should the
   diagnostic additionally refuse (or flag) symlinked config files?
6. Exit 3 on missing key also fires for operators who only publish
   anonymously. Is the documented "anonymous callers ignore exit 3"
   rule acceptable, or should anonymous intent be an explicit input?
7. Hint and `nextAction` templates name commands (`kofra login …`).
   Confirm no template may interpolate caller values, now or in future
   edits, and whether that rule needs a test pin.

## Compatibility notes

- URL normalization reuses origin semantics: the existing
  `normaliseApi` already returns `url.origin`, which drops userinfo,
  path, query and fragment. The diagnostic additionally reports *that*
  trimming happened (`api.value_trimmed`); the resolver itself is
  untouched.
- State classification for files is new logic beside the resolver, not
  a refactor of it. `readCredentials` / `readLink` keep their
  collapse-to-absent behavior so every existing caller is unaffected.
- Consuming a credential file with unknown extra fields is `valid`:
  unknown fields are ignored, matching the resolver's coercion.
