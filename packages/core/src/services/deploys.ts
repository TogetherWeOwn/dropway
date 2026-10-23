import type { Limits } from "../config";
import type { DropwayContext } from "../context";
import { appOrigin, siteFileUrl, siteUrl } from "../context";
import { ApiError, badRequest, conflict, notFound, tooLarge, unauthorized, forbidden } from "../errors";
import { newId, sha256Hex, SHA256_RE } from "../lib/crypto";
import { extname, normaliseContentType } from "../lib/mime";
import { encodePath, normaliseFilePath } from "../lib/paths";
import { detectFileKind } from "../lib/filetypes";
import { hasScope, type Principal } from "../principal";
import { blobScope, putVerifiedBlob } from "./blobs";
import { emit, meter } from "./events";
import { refreshLive } from "./live";
import { createSite, discardNewSite, getVersion, serializeVersion, type SiteRow, type SiteSettingsInput, type VersionRow } from "./sites";

/** One entry of a deploy manifest as sent by clients. */
export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  contentType?: string | null;
}

export interface NormalisedEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface Warning {
  code: string;
  message: string;
}

export interface DeployOptions {
  /** Internal first-version path; never parsed from an HTTP input. */
  transferCreate?: boolean;
  message?: unknown;
  /** How the version was made: "api", "publish", "zip", "restore"... */
  source?: string;
  /** Client attribution, from the X-Kofra-Client header (e.g. "claude-code/1.0"). */
  client?: string | null;
  /** Optimistic concurrency: fail with 409 version_conflict if the live version is no longer this one. */
  baseVersionId?: unknown;
}

/** Validate and normalise a manifest against size/count limits. */
export function validateManifest(files: unknown, lim: Limits): { entries: NormalisedEntry[]; totalBytes: number } {
  if (!Array.isArray(files) || files.length === 0) {
    throw badRequest("files_required", "files must be a non-empty array.", 'Send {"files":[{"path":"index.html","size":123,"sha256":"<hex>","contentType":"text/html"}]}.');
  }
  if (files.length > lim.maxFiles) {
    throw badRequest("too_many_files", `A version can have at most ${lim.maxFiles} files.`, "Split the content across several sites or trim build output (source maps, duplicates). Never drop files silently.", {
      limit: lim.maxFiles,
      received: files.length,
    });
  }
  const seen = new Set<string>();
  const entries: NormalisedEntry[] = [];
  let totalBytes = 0;
  for (const raw of files) {
    const f = raw as Partial<ManifestEntry>;
    if (!f || typeof f !== "object") throw badRequest("invalid_manifest", "Each file must be an object with path, size and sha256.");
    const path = normaliseFilePath(String(f.path ?? ""));
    if (seen.has(path)) throw badRequest("duplicate_path", `The path "${path}" appears more than once.`);
    seen.add(path);
    const size = Number(f.size);
    if (!Number.isInteger(size) || size < 0) throw badRequest("invalid_size", `size for "${path}" must be a non-negative integer (bytes).`);
    if (size > lim.maxFileBytes) {
      throw tooLarge("file_too_large", `"${path}" is ${size} bytes; the per-file limit is ${lim.maxFileBytes}.`, "Compress or split the file.", { path, size, limit: lim.maxFileBytes });
    }
    const sha256 = String(f.sha256 ?? "").toLowerCase();
    if (!SHA256_RE.test(sha256)) throw badRequest("invalid_sha256", `sha256 for "${path}" must be 64 hex characters.`, "Compute it with `sha256sum <file>` or `shasum -a 256 <file>`.");
    totalBytes += size;
    entries.push({ path, size, sha256, contentType: normaliseContentType(f.contentType, path) });
  }
  if (totalBytes > lim.maxSiteBytes) {
    throw tooLarge("site_too_large", `This version is ${totalBytes} bytes; the limit is ${lim.maxSiteBytes}.`, "Split the content across several sites.", {
      totalBytes,
      limit: lim.maxSiteBytes,
    });
  }
  return { entries, totalBytes };
}

/** Stable digest of a manifest, used to detect byte-identical republishes. */
export async function manifestHash(entries: NormalisedEntry[]): Promise<string> {
  const lines = entries.map((e) => `${e.path}\u0000${e.sha256}\u0000${e.contentType}`).sort();
  return sha256Hex(lines.join("\n"));
}

/** Split values into JSON arrays of at most ~maxBytes each (D1 caps a bound value at 2 MB). */
function jsonChunks<T>(items: T[], maxBytes = 800_000): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const item of items) {
    const s = JSON.stringify(item);
    if (cur.length && size + s.length + 1 > maxBytes) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(s);
    size += s.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

/** sha256 values from `shas` that the given scope has not yet proven it holds. */
export async function missingForScope(dc: DropwayContext, scope: string, shas: string[]): Promise<string[]> {
  const unique = [...new Set(shas)];
  if (!unique.length) return [];
  const present = new Set<string>();
  const stmts = jsonChunks(unique).map((json) =>
    dc.env.DB.prepare(
      `SELECT bs.sha256 FROM blob_scopes bs JOIN blobs b ON b.sha256 = bs.sha256
        WHERE bs.scope = ? AND bs.sha256 IN (SELECT value FROM json_each(?))`,
    ).bind(scope, json),
  );
  const results = await dc.env.DB.batch<{ sha256: string }>(stmts);
  for (const r of results) for (const row of r.results) present.add(row.sha256);
  return unique.filter((s) => !present.has(s));
}

function siteOwner(site: SiteRow) {
  return { siteId: site.id, tenantId: site.tenant_id };
}

/**
 * Start a deploy: record a pending version with its full manifest and report
 * which files still need uploading. Files this owner already stored are reused.
 * A byte-identical manifest returns { unchanged: true } and records nothing.
 */
export async function createDeploy(dc: DropwayContext, p: Principal, site: SiteRow, files: unknown, opts: DeployOptions = {}) {
  if (site.mode === "transfer" && !opts.transferCreate) throw conflict("transfer_immutable", "Transfer files cannot be replaced.", "Create a new transfer instead.");
  const lim = await dc.adapters.policy.limits(p, siteOwner(site), dc);
  const { entries, totalBytes } = validateManifest(files, lim);
  await dc.adapters.policy.beforeDeploy?.(p, { siteId: site.id, tenantId: site.tenant_id, fileCount: entries.length, totalBytes }, dc);

  const baseVersionId = opts.baseVersionId == null || opts.baseVersionId === "" ? null : String(opts.baseVersionId);
  if (baseVersionId && baseVersionId !== site.current_version_id) throw versionConflict(site);

  const hash = await manifestHash(entries);
  const origin = appOrigin(dc);
  if (site.current_version_id) {
    const current = await getVersion(dc, site.id, site.current_version_id);
    if (current && current.manifest_hash === hash) {
      return {
        unchanged: true,
        deploy: { ...serializeVersion(current, site.current_version_id), siteSlug: site.slug },
        missing: [] as string[],
        uploads: [] as Array<Record<string, unknown>>,
        finalizeUrl: null,
        next: "Nothing changed: the live version already has exactly these files. No new version was created.",
      };
    }
  }

  const now = Date.now();
  const version: VersionRow = {
    id: newId("ver"),
    site_id: site.id,
    number: 0,
    status: "pending",
    file_count: entries.length,
    total_bytes: totalBytes,
    manifest_hash: hash,
    base_version_id: baseVersionId,
    source: opts.source ?? "api",
    client: opts.client ? String(opts.client).slice(0, 120) : null,
    message: opts.message == null ? null : String(opts.message).slice(0, 500),
    created_by: p.kind === "member" ? p.memberId : p.kind,
    created_at: now,
    finalized_at: null,
  };
  const stmts: D1PreparedStatement[] = [
    dc.env.DB.prepare(
      `INSERT INTO versions (id, site_id, number, status, file_count, total_bytes, manifest_hash, base_version_id, source, client, message, created_by, created_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM versions WHERE site_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      version.id, site.id, site.id, version.status, version.file_count, version.total_bytes, version.manifest_hash,
      version.base_version_id, version.source, version.client, version.message, version.created_by, version.created_at,
    ),
  ];
  // One statement per ~800 KB of manifest, whatever the file count (D1 limits bound parameters, not value size).
  for (const json of jsonChunks(entries.map((e) => [e.path, e.sha256, e.size, e.contentType]))) {
    stmts.push(
      dc.env.DB.prepare(
        `INSERT INTO version_files (version_id, path, sha256, size, content_type)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
           FROM json_each(?)`,
      ).bind(version.id, json),
    );
  }
  await dc.env.DB.batch(stmts);
  const numbered = await dc.env.DB.prepare("SELECT number FROM versions WHERE id = ?").bind(version.id).first<{ number: number }>();
  version.number = numbered?.number ?? 1;

  // Check presence only after the manifest rows exist, so cleanup never deletes a blob we are about to reuse.
  const missing = await missingForScope(dc, blobScope(siteOwner(site)), entries.map((e) => e.sha256));
  const bySha = new Map<string, NormalisedEntry[]>();
  for (const e of entries) bySha.set(e.sha256, [...(bySha.get(e.sha256) ?? []), e]);
  const base = `${origin}/api/v1/sites/${site.slug}/deploys/${version.id}`;
  return {
    unchanged: false,
    deploy: { ...serializeVersion(version, site.current_version_id), siteSlug: site.slug },
    missing,
    uploads: missing.map((sha) => {
      const es = bySha.get(sha)!;
      return {
        sha256: sha,
        size: es[0]!.size,
        paths: es.map((e) => e.path),
        method: "PUT",
        url: `${origin}/api/v1/blobs/${sha}`,
        headers: { "Content-Type": es[0]!.contentType },
      };
    }),
    finalizeUrl: `${base}/finalize`,
    next:
      missing.length === 0
        ? `All files are already stored. POST ${base}/finalize to go live.`
        : `PUT the raw bytes of each of the ${missing.length} missing files to its upload url (same Authorization header), then POST ${base}/finalize.`,
  };
}

/** Check a manifest against the caps for a site that does not exist yet (throws the same errors as createDeploy). */
export async function precheckManifest(dc: DropwayContext, p: Principal, tenantId: string | null, files: unknown): Promise<void> {
  validateManifest(files, await dc.adapters.policy.limits(p, { siteId: null, tenantId }, dc));
}

/**
 * Create a site and, when `files` is given, start its first deploy (POST /api/v1/sites).
 * The manifest is checked before the site row exists, and if the deploy is still
 * refused (for example by a policy adapter) the new site is removed again, so a
 * failed call never leaves an empty site, a taken slug or a used rate-limit slot.
 */
export async function createSiteWithDeploy(
  dc: DropwayContext,
  p: Principal,
  input: { slug?: string | null } & SiteSettingsInput,
  files: unknown,
  opts: DeployOptions = {},
) {
  const withFiles = files !== undefined;
  const { site, claimToken } = await createSite(dc, p, input, {
    beforeInsert: withFiles ? (owner) => precheckManifest(dc, p, owner.tenantId, files) : undefined,
  });
  if (!withFiles) return { site, claimToken, deploy: null };
  // A new anonymous site is deployed with its own claim token from here on.
  const deployer: Principal = claimToken ? { kind: "claim", siteId: site.id, ip: p.ip } : p;
  try {
    return { site, claimToken, deploy: await createDeploy(dc, deployer, site, files, opts) };
  } catch (e) {
    await discardNewSite(dc, site);
    throw e;
  }
}

function versionConflict(site: SiteRow) {
  return conflict(
    "version_conflict",
    "The live version changed since baseVersionId (someone else published).",
    "Fetch the site (GET /api/v1/sites/:slug), reconcile with its files, and deploy again with the new currentVersionId as baseVersionId.",
    { liveVersionId: site.current_version_id },
  );
}

/** Store a blob uploaded by a client. R2 verifies the SHA-256 while it streams in. */
export async function uploadBlob(
  dc: DropwayContext,
  p: Principal,
  shaInput: string,
  body: ReadableStream | null,
  contentLength: number | null,
  contentType: string | null,
) {
  const cancel = () => body?.cancel().catch(() => {});
  if (p.kind !== "member" && p.kind !== "claim") {
    await cancel();
    throw unauthorized("Uploads need the API key or claim token used to create the deploy.");
  }
  if (p.kind === "member" && !hasScope(p, "sites:write")) {
    await cancel();
    throw forbidden('This key lacks the "sites:write" scope.', undefined, "insufficient_scope");
  }
  const sha = shaInput.toLowerCase();
  if (!SHA256_RE.test(sha)) {
    await cancel();
    throw badRequest("invalid_sha256", "The URL must end in the file's 64-character hex SHA-256.");
  }
  let sql = `SELECT vf.size, s.id AS site_id, s.tenant_id FROM version_files vf
               JOIN versions v ON v.id = vf.version_id
               JOIN sites s ON s.id = v.site_id
              WHERE vf.sha256 = ? AND v.status = 'pending' AND s.deleted_at IS NULL`;
  const binds: unknown[] = [sha];
  if (p.kind === "member") {
    sql += " AND s.tenant_id = ?";
    binds.push(p.tenantId);
    if (p.siteId) {
      sql += " AND s.id = ?";
      binds.push(p.siteId);
    }
  } else {
    sql += " AND s.id = ? AND s.tenant_id IS NULL";
    binds.push(p.siteId);
  }
  const expected = await dc.env.DB.prepare(sql + " LIMIT 1").bind(...binds).first<{ size: number; site_id: string; tenant_id: string | null }>();
  if (!expected) {
    await cancel();
    throw notFound(
      "blob_not_expected",
      "No pending deploy you control lists a file with this SHA-256.",
      "Create a deploy with POST /api/v1/sites/:slug/deploys first; upload only the sha256 values it returns as missing.",
    );
  }
  const scope = blobScope({ tenantId: expected.tenant_id, siteId: expected.site_id });
  const already = (await missingForScope(dc, scope, [sha])).length === 0;
  if (already) {
    await cancel();
    return { sha256: sha, size: expected.size, stored: true, existed: true };
  }
  if (contentLength === null || !Number.isFinite(contentLength)) {
    await cancel();
    throw new ApiError(411, "length_required", "Send a Content-Length header with the upload.", "Upload the raw file bytes as the request body (no multipart, no chunked encoding).");
  }
  if (contentLength !== expected.size) {
    await cancel();
    throw badRequest("size_mismatch", `The deploy declared ${expected.size} bytes for this file but the upload is ${contentLength} bytes.`, "Re-check the file and its size in the manifest.", {
      expected: expected.size,
      received: contentLength,
    });
  }
  await putVerifiedBlob(dc, scope, sha, body ?? new Uint8Array(0), expected.size, contentType);
  meter(dc, { type: "blob_upload", tenantId: expected.tenant_id, sha256: sha, bytes: expected.size, at: Date.now() });
  return { sha256: sha, size: expected.size, stored: true, existed: false };
}

/** Atomically make a pending version live. Retrying a finished finalize is safe. */
export async function finalizeDeploy(dc: DropwayContext, p: Principal, site: SiteRow, versionId: string, transferCreate = false) {
  if (site.mode === "transfer" && !transferCreate) throw conflict("transfer_immutable", "Transfer files cannot be replaced.", "Create a new transfer instead.");
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("deploy_not_found", `No deploy ${versionId} on site ${site.slug}.`, "Start one with POST /api/v1/sites/:slug/deploys.");
  if (version.status === "ready") {
    return { version, replayed: true, live: version.id === site.current_version_id, warnings: [] as Warning[] };
  }
  const scope = blobScope(siteOwner(site));
  const { results: missingRows } = await dc.env.DB.prepare(
    `SELECT DISTINCT vf.sha256 FROM version_files vf
       LEFT JOIN blob_scopes bs ON bs.sha256 = vf.sha256 AND bs.scope = ?
       LEFT JOIN blobs b ON b.sha256 = vf.sha256
      WHERE vf.version_id = ? AND (bs.sha256 IS NULL OR b.sha256 IS NULL) LIMIT 200`,
  )
    .bind(scope, version.id)
    .all<{ sha256: string }>();
  if (missingRows.length) {
    throw conflict("missing_blobs", `${missingRows.length} file(s) of this deploy have not been uploaded yet.`, "PUT each missing sha256 to /api/v1/blobs/:sha256, then finalize again.", {
      missing: missingRows.map((r) => r.sha256),
    });
  }
  const now = Date.now();
  const [, upd] = await dc.env.DB.batch([
    dc.env.DB.prepare("UPDATE versions SET status = 'ready', finalized_at = ? WHERE id = ? AND status = 'pending'").bind(now, version.id),
    // The base check sits inside the same transaction as the pointer flip.
    dc.env.DB.prepare(
      `UPDATE sites SET current_version_id = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR current_version_id IS ?)`,
    ).bind(version.id, now, site.id, version.base_version_id, version.base_version_id),
  ]);
  if (!upd?.meta.changes) {
    // Roll the version back to pending so it can be retried after reconciling.
    await dc.env.DB.prepare("UPDATE versions SET status = 'pending', finalized_at = NULL WHERE id = ?").bind(version.id).run();
    const fresh = await dc.env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site.id).first<SiteRow>();
    if (!fresh || fresh.deleted_at) throw notFound("site_not_found", `Site ${site.slug} was deleted.`);
    throw versionConflict(fresh);
  }
  await refreshLive(dc, site.id);
  const finalized: VersionRow = { ...version, status: "ready", finalized_at: now };
  const ref = { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) };
  emit(dc, "onPublish", {
    kind: "deploy",
    site: ref,
    version: { id: finalized.id, number: finalized.number, fileCount: finalized.file_count, totalBytes: finalized.total_bytes },
    principal: p,
    at: now,
  });
  meter(dc, { type: "deploy", tenantId: site.tenant_id, siteId: site.id, versionId: finalized.id, fileCount: finalized.file_count, totalBytes: finalized.total_bytes, at: now });
  return { version: finalized, replayed: false, live: true, warnings: await deployWarnings(dc, site, version.id) };
}

async function deployWarnings(dc: DropwayContext, site: SiteRow, versionId: string): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const { results } = await dc.env.DB.prepare(
    `SELECT path FROM version_files WHERE version_id = ?
       AND (path IN ('index.html','index.htm','index.md','README.md','readme.md') OR path LIKE '%.wasm' OR path LIKE '%.wasm.br' OR path LIKE '%.wasm.gz') LIMIT 10`,
  )
    .bind(versionId)
    .all<{ path: string }>();
  const count = await dc.env.DB.prepare("SELECT file_count FROM versions WHERE id = ?").bind(versionId).first<{ file_count: number }>();
  const hasIndex = results.some((r) => /^(index\.html?|index\.md|readme\.md)$/i.test(r.path));
  if (!hasIndex && (count?.file_count ?? 0) > 1) {
    warnings.push({ code: "no_index", message: "There is no index.html (or index.md / README.md) at the root, so the site root shows a file listing. Link to files by path." });
  }
  if (results.some((r) => /\.wasm(\.br|\.gz)?$/.test(r.path)) && site.cross_origin_isolation !== 1) {
    warnings.push({
      code: "wasm_without_cross_origin_isolation",
      message: 'This version ships WebAssembly. If it uses threads (SharedArrayBuffer), PATCH the site with {"crossOriginIsolation": true}. Single-threaded builds need nothing.',
    });
  }
  return warnings;
}

export async function getDeployStatus(dc: DropwayContext, site: SiteRow, versionId: string) {
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("deploy_not_found", `No deploy ${versionId} on site ${site.slug}.`);
  let missing: string[] = [];
  if (version.status === "pending") {
    const { results } = await dc.env.DB.prepare("SELECT DISTINCT sha256 FROM version_files WHERE version_id = ?").bind(version.id).all<{ sha256: string }>();
    missing = await missingForScope(dc, blobScope(siteOwner(site)), results.map((r) => r.sha256));
  }
  return { deploy: serializeVersion(version, site.current_version_id), missing };
}

export async function listVersions(dc: DropwayContext, site: SiteRow, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const { results } = await dc.env.DB.prepare("SELECT * FROM versions WHERE site_id = ? AND status = 'ready' ORDER BY number DESC LIMIT ?")
    .bind(site.id, limit)
    .all<VersionRow>();
  return results.map((v) => serializeVersion(v, site.current_version_id));
}

/** Make an older finalized version live again (a pointer flip; no files are copied). */
export async function restoreVersion(dc: DropwayContext, p: Principal, site: SiteRow, versionId: string) {
  if (site.mode === "transfer") throw conflict("transfer_immutable", "Transfer files cannot be restored.", "Create a new transfer instead.");
  const version = await getVersion(dc, site.id, versionId);
  if (!version || version.status !== "ready") {
    throw notFound("version_not_found", `No finalized version ${versionId} on site ${site.slug}.`, "List versions with GET /api/v1/sites/:slug/versions.");
  }
  if (version.id === site.current_version_id) return { restored: false, alreadyLive: true, version: serializeVersion(version, version.id) };
  const now = Date.now();
  await dc.env.DB.prepare("UPDATE sites SET current_version_id = ?, updated_at = ? WHERE id = ?").bind(version.id, now, site.id).run();
  await refreshLive(dc, site.id);
  emit(dc, "onPublish", {
    kind: "restore",
    site: { id: site.id, slug: site.slug, tenantId: site.tenant_id, url: siteUrl(dc, site.slug) },
    version: { id: version.id, number: version.number, fileCount: version.file_count, totalBytes: version.total_bytes },
    principal: p,
    at: now,
  });
  return { restored: true, alreadyLive: false, version: serializeVersion(version, version.id) };
}

/** Permanently delete one non-live version (for example one that leaked a secret). */
export async function deleteVersion(dc: DropwayContext, site: SiteRow, versionId: string) {
  if (site.mode === "transfer") throw conflict("transfer_immutable", "Transfer files cannot be deleted separately.", "Revoke the transfer; retained bytes are purged by cleanup when not held.");
  const version = await getVersion(dc, site.id, versionId);
  if (!version) throw notFound("version_not_found", `No version ${versionId} on site ${site.slug}.`);
  if (version.id === site.current_version_id) throw conflict("version_is_live", "You cannot delete the live version.", "Restore or publish another version first.");
  await dc.env.DB.batch([
    dc.env.DB.prepare("DELETE FROM version_files WHERE version_id = ?").bind(version.id),
    dc.env.DB.prepare("DELETE FROM versions WHERE id = ?").bind(version.id),
  ]);
  return { deleted: true, id: version.id };
}

export interface FileRow {
  path: string;
  sha256: string;
  size: number;
  content_type: string;
}

/** The file manifest of the live version (or of `versionId`), with public and raw URLs. */
export async function listFiles(dc: DropwayContext, site: SiteRow, versionId: string | null) {
  const vid = versionId ?? site.current_version_id;
  if (!vid) return { version: null, files: [] };
  const version = await getVersion(dc, site.id, vid);
  if (!version) throw notFound("version_not_found", `No version ${vid} on site ${site.slug}.`);
  const { results } = await dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? ORDER BY path")
    .bind(vid)
    .all<FileRow>();
  const api = `${appOrigin(dc)}/api/v1/sites/${site.slug}/files/`;
  return {
    version: serializeVersion(version, site.current_version_id),
    files: results.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      contentType: f.content_type,
      kind: detectFileKind(f.path, f.content_type),
      extension: extname(f.path),
      url: siteFileUrl(dc, site.slug, f.path),
      rawUrl: api + encodePath(f.path),
    })),
  };
}

export async function getFile(dc: DropwayContext, site: SiteRow, path: string, versionId?: string | null): Promise<FileRow | null> {
  if (site.mode === "transfer") throw forbidden("Transfer bytes are only available as sites-host downloads.", "Use the transfer page's download links.", "transfer_download_required");
  const vid = versionId ?? site.current_version_id;
  if (!vid) return null;
  return dc.env.DB.prepare("SELECT path, sha256, size, content_type FROM version_files WHERE version_id = ? AND path = ?").bind(vid, path).first<FileRow>();
}
