/**
 * Where the CLI keeps state. Node only.
 *
 * - Credentials: <config dir>/credentials.json, mode 0600, one API key per
 *   instance origin plus the default instance. Config dir: $KOFRA_CONFIG_DIR,
 *   else $XDG_CONFIG_HOME/dropway, else ~/.config/dropway (%APPDATA%\dropway on Windows).
 * - Project link: ./dropway.json (no secrets, safe to commit) remembers which
 *   site each published path maps to, so re-running `kofra publish dist`
 *   updates the same site instead of creating a new one.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KOFRA_CONFIG_DIR) return resolve(env.KOFRA_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "dropway");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "dropway");
  return join(homedir(), ".config", "dropway");
}

export interface InstanceCredentials {
  key: string;
  email?: string | null;
  tenantId?: string | null;
  savedAt: string;
}

export interface CredentialsFile {
  version: 1;
  /** Instance used when nothing else names one. */
  default: string | null;
  instances: Record<string, InstanceCredentials>;
}

const empty = (): CredentialsFile => ({ version: 1, default: null, instances: {} });

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "credentials.json");
}

export async function readCredentials(env: NodeJS.ProcessEnv = process.env): Promise<CredentialsFile> {
  let text: string;
  try {
    text = await readFile(credentialsPath(env), "utf8");
  } catch {
    return empty();
  }
  try {
    const v = JSON.parse(text) as Partial<CredentialsFile>;
    return { version: 1, default: typeof v.default === "string" ? v.default : null, instances: v.instances && typeof v.instances === "object" ? v.instances : {} };
  } catch {
    return empty();
  }
}

/** Write atomically with owner-only permissions. */
async function writePrivate(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

export async function saveCredentials(api: string, creds: Omit<InstanceCredentials, "savedAt">, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = await readCredentials(env);
  file.instances[api] = { ...creds, savedAt: new Date().toISOString() };
  file.default = api;
  const path = credentialsPath(env);
  await writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
}

/** Remove the key for one instance. Returns false when there was none. */
export async function removeCredentials(api: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = await readCredentials(env);
  if (!file.instances[api]) return false;
  delete file.instances[api];
  if (file.default === api) file.default = Object.keys(file.instances)[0] ?? null;
  const path = credentialsPath(env);
  if (!Object.keys(file.instances).length) await rm(path, { force: true });
  else await writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
  return true;
}

// ---------------------------------------------------------------- project link

export const LINK_FILE = "dropway.json";

export interface ProjectLink {
  $comment?: string;
  /** Instance origin the sites below live on. */
  api?: string;
  /** Published path (relative to this file, POSIX) -> site slug. */
  sites?: Record<string, string>;
}

export function linkPath(cwd: string): string {
  return join(cwd, LINK_FILE);
}

export async function readLink(cwd: string): Promise<ProjectLink | null> {
  try {
    const v = JSON.parse(await readFile(linkPath(cwd), "utf8")) as ProjectLink;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Key under which a published path is recorded: relative to cwd, POSIX, "." for cwd itself. */
export function linkKey(cwd: string, target: string): string {
  const rel = relative(cwd, resolve(cwd, target)).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/** Record (or update) the site for a published path. Never stores credentials. */
export async function writeLink(cwd: string, api: string, key: string, slug: string): Promise<{ path: string; created: boolean }> {
  const existing = await readLink(cwd);
  const created = !existing;
  const link: ProjectLink = existing ?? { $comment: "Written by the kofra CLI: which site each published path updates. Safe to commit (no secrets)." };
  if (link.api && link.api !== api) return { path: linkPath(cwd), created: false };
  link.api = api;
  link.sites = { ...(link.sites ?? {}), [key]: slug };
  await writeFile(linkPath(cwd), `${JSON.stringify(link, null, 2)}\n`);
  return { path: linkPath(cwd), created };
}
