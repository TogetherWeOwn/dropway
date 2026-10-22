# dropway CLI

Publish a folder, a file or a `.zip` to a live URL on any [Dropway](https://github.com/TogetherWeOwn/dropway)
instance. Built for AI agents and scripts: one command, one JSON object on stdout, stable exit codes,
and only the bytes the instance does not already have are uploaded.

```sh
npx dropway login --api https://dropway.example.workers.dev   # paste an API key once
npx dropway publish ./dist                                     # prints the live URL
npx dropway publish ./dist --json                              # one JSON object for agents
```

Zero runtime dependencies. Node.js 20 or newer.

> The npm package is prepared but not published yet. Until it is, run the CLI from a clone of the
> repository: `npm install`, then `node packages/cli/bin/dropway.mjs <command>` (Node 22.18+ runs the
> TypeScript source directly; on older Node run `npm run build -w dropway` first).

## Commands

| Command | What it does |
|---|---|
| `publish <path>` | Publish a folder, a single file or a `.zip`. Creates a site, or updates one with `--site <name>` |
| `list` | Your sites (`--all` for every page) |
| `site <name>` | One site: URL, live version, settings |
| `files <name>` | Files of the live version (or `--version v3`) with their URLs |
| `versions <name>` | Every version, newest first; the live one is marked |
| `restore <name> [v3]` | Make an older version live again. Without a version: the one before the live version. Alias `rollback` |
| `delete <name> --yes` | Delete a site. `--version v3` deletes one non-live version instead |
| `whoami` | The instance, your identity and your key's scopes |
| `login` / `logout` | Save or forget an API key for an instance |
| `setup --email <you>` | First run of a new instance: create the owner and save their key |
| `api [METHOD] <path>` | Call any REST endpoint, e.g. `dropway api PATCH /sites/my-site --data '{"spa":true}'` |

`dropway help <command>` shows every option.

## Publishing

```sh
dropway publish ./dist                         # new site with a generated name
dropway publish ./dist --site team-report      # update team-report, or create it with that name
dropway publish report.md                      # one file: served at the site root
dropway publish site.zip                       # the instance unpacks it (one request, 25 MB by default)
dropway publish ./dist --wait --json           # return only once the URL serves the new version
dropway publish ./dist --dry-run               # list what would be uploaded; contacts nothing
```

How it works: the CLI hashes every file (SHA-256), sends the list, uploads only the files the
instance is missing (6 in parallel, retried on rate limits, server errors and network errors), then
makes the new version live in one atomic step. Publishing identical files again reports
`"unchanged": true` and creates no version.

After the first publish with a key, `./dropway.json` records which site each published path updates,
so running the same command again updates that site. It holds no secrets and is safe to commit.
Use `--new` for a fresh site, `--no-save` to skip writing it.

Never published: `.git`, `node_modules`, `.env*`, `.dev.vars*`, `.npmrc`, `*.pem`, `*.key`, `*.p12`,
SSH keys, `.dropway/`, `.DS_Store`, and anything matched by `<path>/.dropwayignore` (gitignore-style;
`!pattern` re-includes). Text files (up to 4 MB) that contain credentials (private keys, cloud and API
tokens, Dropway keys) stop the publish with exit code 2 unless you pass `--allow-secrets`.

Anonymous publishing (`--anonymous`) works only on instances that turned it on. The site expires and
the output includes a `claimToken`: keep it to update the site (`--key <claimToken> --site <name>`) or
to claim it into an account.

## Output for agents

With `--json`, stdout carries exactly one JSON object; progress and notes go to stderr.

```json
{
  "ok": true,
  "url": "https://dropway.example.workers.dev/s/bright-otter-x7k2/",
  "slug": "bright-otter-x7k2",
  "created": false,
  "unchanged": false,
  "version": { "id": "ver_...", "number": 3, "live": true, "fileCount": 12, "totalBytes": 48211 },
  "files": 12,
  "uploaded": 2,
  "reused": 10,
  "bytesUploaded": 5120,
  "warnings": [],
  "api": "https://dropway.example.workers.dev"
}
```

Errors (also on stdout with `--json`):

```json
{
  "ok": false,
  "exitCode": 5,
  "error": {
    "code": "version_conflict",
    "message": "The live version changed since baseVersionId (someone else published).",
    "hint": "Fetch the site (GET /api/v1/sites/:slug), reconcile with its files, and deploy again with the new currentVersionId as baseVersionId.",
    "status": 409,
    "retryable": false
  }
}
```

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | |
| 1 | Unexpected error | Report it with the output |
| 2 | Usage error, refused without `--yes`, or files that look like secrets | Fix the command or the files |
| 3 | No key, invalid key, or missing scope | `dropway login`, or a key with the right scope |
| 4 | Not found (site, version, file) | Check the name with `dropway list` |
| 5 | Conflict: the live version moved (`--base`), or the name is taken | Re-read, then publish again |
| 6 | Invalid or over a limit (file too large, too many files) | Change the content |
| 7 | Retryable: rate limited, server error, network error | Retry later |
| 8 | `--wait` timed out before the URL served the new version | The publish succeeded; retry the check |

## Configuration

| Setting | Flag | Environment | Saved |
|---|---|---|---|
| Instance URL | `--api <url>` | `DROPWAY_API` (or `DROPWAY_URL`) | `./dropway.json`, then your last `login` |
| API key | `--key <key>` | `DROPWAY_API_KEY` | `<config dir>/credentials.json` (mode 0600, one key per instance) |
| Bootstrap key (setup only) | | `DROPWAY_BOOTSTRAP_KEY` | never |
| Attribution shown per version | | `DROPWAY_CLIENT` (e.g. `my-agent/1.2`) | |

Config dir: `$DROPWAY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/dropway`, else `~/.config/dropway`
(`%APPDATA%\dropway` on Windows). `DROPWAY_API_KEY` applies to whichever instance you target, so set
it per instance in CI. The CLI never prompts when stdin is not a terminal: pipe keys on stdin
(`echo "$KEY" | dropway login --api <url>`), and pass `--yes` for deletions.

## Development

```sh
npm install                 # at the repository root
npm run test:cli            # unit tests + end-to-end tests against a local Worker
npm run build -w dropway    # bundle to packages/cli/dist/dropway.mjs
```

Source layout: `src/client.ts` (HTTP + errors), `src/publish.ts` (the upload protocol; runtime-neutral and
also tested inside the Workers runtime), `src/files.ts` (walk, ignore, hash, secret scan), `src/main.ts`
(commands), `src/config.ts` (credentials and `dropway.json`).

## License

MIT
