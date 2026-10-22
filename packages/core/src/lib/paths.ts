import { badRequest } from "../errors";

const MAX_PATH = 1024;

/**
 * Normalise a file path inside a site: forward slashes, no leading slash,
 * no "." or ".." segments, no empty segments, no control characters.
 * Throws an agent-friendly 400 for anything unsafe.
 */
export function normaliseFilePath(input: string): string {
  if (typeof input !== "string") throw badRequest("invalid_path", "File path must be a string.");
  let p = input.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "");
  const segments = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) throw badRequest("invalid_path", `File path "${input}" is empty.`, "Use paths like index.html or assets/app.js.");
  for (const s of segments) {
    if (s === "..") throw badRequest("invalid_path", `File path "${input}" contains "..".`, "Paths must stay inside the site root.");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(s)) throw badRequest("invalid_path", `File path "${input}" contains control characters.`);
  }
  const out = segments.join("/");
  if (out.length > MAX_PATH) throw badRequest("invalid_path", `File path is longer than ${MAX_PATH} characters.`);
  return out;
}

/** Decode the URL path of a site request into a manifest lookup key ("" = root, trailing "/" = directory). */
export function requestPathToFilePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const trailing = decoded.endsWith("/");
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  const joined = segments.join("/");
  return trailing && joined ? `${joined}/` : joined;
}

/** Percent-encode each segment of a file path for use in a URL. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** If every path shares one top-level folder and there is no root index, strip it (common for zips). */
export function stripCommonRoot<T extends { path: string }>(files: T[]): T[] {
  if (files.length === 0) return files;
  const first = files[0]!.path.split("/")[0]!;
  if (!files.every((f) => f.path.includes("/") && f.path.split("/")[0] === first)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}
