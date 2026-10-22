/**
 * Which local files never get published. A gitignore-style subset:
 * `#` comments, `!` negation, `*` / `?` within a segment, `**` across segments,
 * a trailing `/` matches directories only, a leading or inner `/` anchors the
 * pattern to the publish root; otherwise it matches a name at any depth.
 */

/** Always ignored, before .dropwayignore (which may re-include with `!`). */
export const DEFAULT_IGNORES = [
  // No trailing slash: in a git worktree or submodule, .git is a file.
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".wrangler",
  ".dropway",
  ".dropwayignore",
  ".env",
  ".env.*",
  ".dev.vars",
  ".dev.vars.*",
  ".npmrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_rsa.*",
  "id_ecdsa",
  "id_ed25519",
  "id_ed25519.*",
  ".DS_Store",
  "Thumbs.db",
];

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**/" = any number of directories; "**" at the end = everything below.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`);
}

export function compileRules(lines: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const raw of lines) {
    let line = raw.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    line = line.replace(/(?<!\\)\s+$/, "");
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/") || line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    rules.push({ negate, dirOnly, re: globToRegExp(line, anchored) });
  }
  return rules;
}

export class IgnoreMatcher {
  private readonly rules: Rule[];

  constructor(extraLines: string[] = [], opts: { defaults?: boolean } = {}) {
    this.rules = compileRules([...(opts.defaults === false ? [] : DEFAULT_IGNORES), ...extraLines]);
  }

  /** Is this relative POSIX path ignored? `isDir` for directories. The last matching rule wins. */
  ignores(path: string, isDir = false): boolean {
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(path)) ignored = !r.negate;
    }
    return ignored;
  }

  /** Like ignores(), but also true when any parent directory is ignored (as git does). */
  ignoresWithParents(path: string, isDir = false): boolean {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (this.ignores(parts.slice(0, i).join("/"), true)) return true;
    return this.ignores(path, isDir);
  }
}
