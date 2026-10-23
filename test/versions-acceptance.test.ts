import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { freshInstance, jsonBody, manifestEntry, ORIGIN, type Instance } from "./helpers";
import { connectMcp, type McpTestClient } from "./mcp-helpers";

// R-05 / PUB-02, PUB-07, PUB-11, VER-02. Exercise public operations:
// no service mocks, SQL writes, or implementation-derived expectations.
let dw: Instance;
const clients: McpTestClient[] = [];
beforeEach(async () => {
  dw = await freshInstance();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.client.close()));
});

async function agent(key = dw.ownerKey) {
  const client = await connectMcp(dw, key);
  clients.push(client);
  return client;
}

async function publish(site: string, files = [{ path: "index.html", content: "one" }]) {
  const client = await agent();
  const result = await client.call("publish_site", { site, files });
  expect(result.isError).toBe(false);
  expect(result.data.status).toBe("live");
  return result.data;
}

const referenceKinds = ["live", "prefixed number", "number", "id"] as const;
type ReferenceKind = (typeof referenceKinds)[number];
function reference(kind: ReferenceKind, version: { id: string; number: number }) {
  if (kind === "live") return "live";
  if (kind === "prefixed number") return `v${version.number}`;
  if (kind === "number") return String(version.number);
  return version.id;
}

// A refresh is useful only if a caller can use the returned item without
// supplying its own key or making another get_version/refresh request.
async function uploadWithReturnedItem(item: any, entry: Awaited<ReturnType<typeof manifestEntry>>) {
  expect(item).toMatchObject({
    path: entry.path, sha256: entry.sha256, size: entry.size, method: "PUT",
    url: `${ORIGIN}/api/v1/blobs/${entry.sha256}`,
    headers: expect.any(Object), curl: expect.any(String),
  });
  const headers = new Headers(item.headers);
  expect(headers.get("authorization")).toEqual(expect.stringMatching(/^Bearer dwu_/));
  expect(item.curl).toContain(item.url);
  expect(item.curl).toContain("--data-binary");
  // In-process Request does not add the HTTP framing that curl supplies.
  headers.set("Content-Length", String(entry.size));
  const response = await dw.call(item.url, { method: item.method, headers, body: entry.bytes });
  expect(response.status).toBe(201);
}

async function pendingSite(site: string) {
  const client = await agent();
  const entry = await manifestEntry("data.txt", "pending bytes");
  const result = await client.call("publish_site", {
    site,
    files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }],
  });
  expect(result.isError).toBe(false);
  expect(result.data.status).toBe("awaiting_upload");
  return { client, entry, result: result.data };
}

describe("R-05 versions routes and compatibility", () => {
  it("creates a manifest version at /versions and makes it live through /versions/finalize", async () => {
    const site = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "canonical" }) });
    expect(site.status).toBe(201);
    const entry = await manifestEntry("index.html", "canonical bytes");
    const created = await dw.json("/api/v1/sites/canonical/versions", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }] }),
    });
    expect(created.status).toBe(201);
    // SPEC 5.5: canonical manifest creation returns the PublishResult upload block.
    expect(created.body.status).toBe("awaiting_upload");
    expect(created.body.version).toMatchObject({ id: expect.any(String), number: 1, status: "pending" });
    expect(created.body.upload.versionId).toBe(created.body.version.id);
    expect(created.body.upload.items).toHaveLength(1);
    await uploadWithReturnedItem(created.body.upload.items[0], entry);
    const finalized = await dw.json(`/api/v1/sites/canonical/versions/${created.body.version.id}/finalize`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(finalized.status).toBe(200);
    expect(await (await dw.call("/s/canonical/index.html")).text()).toBe("canonical bytes");
  });

  it("keeps the legacy /deploys create, get and finalize paths working without a redirect", async () => {
    const site = await dw.json("/api/v1/sites", { key: dw.ownerKey, ...jsonBody({ slug: "legacy" }) });
    expect(site.status).toBe(201);
    const entry = await manifestEntry("index.html", "legacy bytes");
    const created = await dw.json("/api/v1/sites/legacy/deploys", {
      key: dw.ownerKey,
      ...jsonBody({ files: [{ path: entry.path, sha256: entry.sha256, size: entry.size }] }),
    });
    expect(created.status).toBe(201);
    const id = created.body.deploy.id;
    const pending = await dw.json(`/api/v1/sites/legacy/deploys/${id}`, { key: dw.ownerKey });
    expect(pending.status).toBe(200);
    expect(pending.body.deploy).toMatchObject({ id, status: "pending", fileCount: 1, totalBytes: 12 });
    const upload = await dw.call(`/api/v1/blobs/${entry.sha256}`, {
      method: "PUT", key: dw.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) },
    });
    expect(upload.status).toBe(201);
    const finalized = await dw.json(`/api/v1/sites/legacy/deploys/${id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(finalized.status).toBe(200);
    const replay = await dw.json(`/api/v1/sites/legacy/deploys/${id}/finalize`, { method: "POST", key: dw.ownerKey });
    expect(replay.status).toBe(200);
    expect(await (await dw.call("/s/legacy/index.html")).text()).toBe("legacy bytes");
    const list = await dw.json("/api/v1/sites/legacy/versions", { key: dw.ownerKey });
    expect(list.body.versions).toEqual([expect.objectContaining({ id, number: 1, live: true })]);
  });

  it.each(["slug", "id"] as const)("lists versions using a site %s", async (kind) => {
    const first = await publish("site-reference");
    const second = await publish("site-reference", [{ path: "index.html", content: "two" }]);
    // Public summaries expose the slug; look up only the fixture's internal id.
    const row = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind("site-reference").first<{ id: string }>();
    const site = kind === "slug" ? "site-reference" : row?.id;
    expect(site).toEqual(expect.any(String));
    const list = await dw.json(`/api/v1/sites/${site}/versions`, { key: dw.ownerKey });
    expect(list.status).toBe(200);
    expect(list.body.versions.map((v: any) => [v.id, v.number, v.live])).toEqual([
      [second.version.id, 2, true], [first.version.id, 1, false],
    ]);
  });

  it.each(referenceKinds)("GET /versions resolves a %s version reference", async (kind) => {
    // Use v12, not just v1, so number parsing cannot pass by reading one digit.
    let live = await publish("numbered");
    for (let number = 2; number <= 12; number++) {
      live = await publish("numbered", [{ path: "index.html", content: `version ${number}` }]);
    }
    const result = await dw.json(`/api/v1/sites/numbered/versions/${reference(kind, live.version)}`, { key: dw.ownerKey });
    expect(result.status).toBe(200);
    expect(result.body.version).toMatchObject({
      id: live.version.id, number: 12, status: "ready", live: true, fileCount: 1, totalBytes: 10,
    });
  });

  it.each(["prefixed number", "number", "id"] as const)("finalizes a pending version using its %s", async (kind) => {
    const { entry, result } = await pendingSite("finalize-reference");
    const uploaded = await dw.call(`/api/v1/blobs/${entry.sha256}`, { method: "PUT", key: dw.ownerKey, body: entry.bytes, headers: { "Content-Length": String(entry.size) } });
    expect(uploaded.status).toBe(201);
    const finalized = await dw.json(`/api/v1/sites/finalize-reference/versions/${reference(kind, result.version)}/finalize`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(finalized.status).toBe(200);
    const replay = await dw.json("/api/v1/sites/finalize-reference/versions/live/finalize", { method: "POST", key: dw.ownerKey });
    expect(replay.status).toBe(200);
    expect(await (await dw.call("/s/finalize-reference/data.txt")).text()).toBe("pending bytes");
  });

  it.each(["prefixed number", "number", "id"] as const)("restores an old version using its %s", async (kind) => {
    const first = await publish("restore-reference");
    await publish("restore-reference", [{ path: "index.html", content: "two" }]);
    const restored = await dw.json(`/api/v1/sites/restore-reference/versions/${reference(kind, first.version)}/restore`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toBe(true);
    expect(await (await dw.call("/s/restore-reference/index.html")).text()).toBe("one");
    const list = await dw.json("/api/v1/sites/restore-reference/versions", { key: dw.ownerKey });
    expect(list.body.versions).toHaveLength(2);
    expect(list.body.versions.find((v: any) => v.live).id).toBe(first.version.id);
  });

  it.each(["prefixed number", "number", "id"] as const)("deletes a non-live version using its %s", async (kind) => {
    const first = await publish("delete-reference");
    const second = await publish("delete-reference", [{ path: "index.html", content: "two" }]);
    const deleted = await dw.json(`/api/v1/sites/delete-reference/versions/${reference(kind, first.version)}`, {
      method: "DELETE", key: dw.ownerKey,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const list = await dw.json("/api/v1/sites/delete-reference/versions", { key: dw.ownerKey });
    expect(list.body.versions.map((v: any) => v.id)).toEqual([second.version.id]);
    expect(await (await dw.call("/s/delete-reference/index.html")).text()).toBe("two");
  });

  it("restoring live is a no-op success and creates no new version", async () => {
    const first = await publish("restore-live");
    const restored = await dw.json("/api/v1/sites/restore-live/versions/live/restore", { method: "POST", key: dw.ownerKey });
    expect(restored.status).toBe(200);
    const list = await dw.json("/api/v1/sites/restore-live/versions", { key: dw.ownerKey });
    expect(list.body.versions).toEqual([expect.objectContaining({ id: first.version.id, live: true })]);
    expect(await (await dw.call("/s/restore-live/index.html")).text()).toBe("one");
  });

  it("deleting live refuses with version_is_live and preserves its bytes", async () => {
    await publish("delete-live");
    const refused = await dw.json("/api/v1/sites/delete-live/versions/live", { method: "DELETE", key: dw.ownerKey });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("version_is_live");
    expect(await (await dw.call("/s/delete-live/index.html")).text()).toBe("one");
  });
});

describe("R-05 partial file updates", () => {
  it("PATCH writes, deletes exact paths and folders, moves by hash, and preserves untouched files and history", async () => {
    const first = await publish("partial-contract", [
      { path: "index.html", content: "one" },
      { path: "keep.txt", content: "keep" },
      { path: "drafts/a.txt", content: "a" },
      { path: "drafts/nested/b.txt", content: "b" },
      { path: "drafts-keep.txt", content: "boundary" },
      { path: "old.txt", content: "move me" },
      { path: "remove.txt", content: "remove" },
    ]);
    const before = await dw.json("/api/v1/sites/partial-contract/files", { key: dw.ownerKey });
    expect(before.status).toBe(200);
    const changed = await dw.json("/api/v1/sites/partial-contract/files", {
      key: dw.ownerKey,
      ...jsonBody({
        baseVersionId: first.version.id,
        files: [{ path: "index.html", content: "two" }, { path: "added.txt", content: "added" }],
        delete: ["drafts/", "remove.txt"],
        move: [{ from: "old.txt", to: "new/moved.txt" }],
      }),
      method: "PATCH",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.status).toBe("live");
    expect(changed.body.files).toMatchObject({ total: 5, stored: 2, reused: 3, pending: 0 });
    const after = await dw.json("/api/v1/sites/partial-contract/files", { key: dw.ownerKey });
    expect(after.body.files.map((f: any) => f.path).sort()).toEqual([
      "added.txt", "drafts-keep.txt", "index.html", "keep.txt", "new/moved.txt",
    ]);
    for (const [from, to] of [["keep.txt", "keep.txt"], ["drafts-keep.txt", "drafts-keep.txt"], ["old.txt", "new/moved.txt"]]) {
      const original = before.body.files.find((f: any) => f.path === from);
      expect(after.body.files.find((f: any) => f.path === to)).toMatchObject({ sha256: original.sha256, size: original.size });
    }
    expect(await (await dw.call("/s/partial-contract/new/moved.txt")).text()).toBe("move me");
    expect(await (await dw.call("/s/partial-contract/index.html")).text()).toBe("two");
    const historical = await dw.json(`/api/v1/sites/partial-contract/files?version=${first.version.id}`, { key: dw.ownerKey });
    expect(historical.status).toBe(200);
    expect(historical.body.files).toEqual(before.body.files);
  });

  it("two independently keyed agents conflict, rebase with update_site_files, and keep both edits live", async () => {
    const admin = await agent();
    const keys: string[] = [];
    for (const name of ["editor-a", "editor-b"]) {
      const key = await admin.call("create_api_key", { name, scopes: ["sites:read", "sites:write"] });
      expect(key.isError).toBe(false);
      keys.push(key.data.key);
    }
    const a = await agent(keys[0]!);
    const b = await agent(keys[1]!);
    const first = await publish("two-editors", [{ path: "index.html", content: "original" }]);
    const aChange = await a.call("update_site_files", {
      site: "two-editors", baseVersionId: first.version.id,
      files: [{ path: "a.txt", content: "agent a" }],
    });
    expect(aChange.isError).toBe(false);
    expect(aChange.data.status).toBe("live");
    const conflict = await dw.json("/api/v1/sites/two-editors/files", {
      key: keys[1], ...jsonBody({ baseVersionId: first.version.id, files: [{ path: "b.txt", content: "agent b" }] }), method: "PATCH",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("version_conflict");
    expect(conflict.body.error.details.liveVersionId).toBe(aChange.data.version.id);
    // Keep checking the rebase even if recovery guidance is the only missing feature.
    expect.soft(conflict.body.error.next).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: expect.any(String), args: expect.any(Object), why: expect.any(String) }),
    ]));
    const toolConflict = await b.call("update_site_files", {
      site: "two-editors", baseVersionId: first.version.id,
      files: [{ path: "b.txt", content: "agent b" }],
    });
    expect(toolConflict.isError).toBe(true);
    expect(toolConflict.data.error.code).toBe("version_conflict");
    expect.soft(toolConflict.data.error.next).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: expect.any(String), args: expect.any(Object), why: expect.any(String) }),
    ]));
    const afterConflict = await b.call("get_site", { site: "two-editors" });
    expect(afterConflict.isError).toBe(false);
    expect(afterConflict.data.site.currentVersionId).toBe(aChange.data.version.id);
    const rebased = await b.call("update_site_files", {
      site: "two-editors", baseVersionId: afterConflict.data.site.currentVersionId,
      files: [{ path: "b.txt", content: "agent b" }],
    });
    expect(rebased.isError).toBe(false);
    expect(rebased.data.status).toBe("live");
    expect(rebased.data.version.number).toBe(3);
    const files = await b.call("list_files", { site: "two-editors" });
    expect(files.data.files.map((f: any) => f.path)).toEqual(["a.txt", "b.txt", "index.html"]);
    for (const [path, content] of [["a.txt", "agent a"], ["b.txt", "agent b"], ["index.html", "original"]] as const) {
      expect(await (await dw.call(new URL(path, rebased.data.url).href)).text()).toBe(content);
    }
    const versions = await b.call("list_versions", { site: "two-editors" });
    expect(versions.data.versions.map((v: any) => v.number)).toEqual([3, 2, 1]);
  });
});

describe("R-05 version status and missing-byte recovery", () => {
  it("get_version reports ready status, file count and byte count", async () => {
    const published = await publish("ready-counts", [
      { path: "index.html", content: "ready" }, { path: "note.txt", content: "café" },
    ]);
    const client = await agent();
    const result = await client.call("get_version", { site: "ready-counts", version: published.version.id });
    expect(result.isError).toBe(false);
    expect(result.data.version).toMatchObject({ status: "ready", live: true, fileCount: 2, totalBytes: 10 });
  });

  it("get_version lists only still-missing files and returns directly usable upload items", async () => {
    const client = await agent();
    const a = await manifestEntry("a.txt", "uploaded first");
    const b = await manifestEntry("b.txt", "uploaded later");
    const pending = await client.call("publish_site", {
      site: "pending-counts", files: [
        { path: "index.html", content: "ready" },
        { path: a.path, sha256: a.sha256, size: a.size },
        { path: b.path, sha256: b.sha256, size: b.size },
      ],
    });
    expect(pending.isError).toBe(false);
    expect(pending.data.status).toBe("awaiting_upload");
    expect(pending.data.files.pending).toBe(2);
    const uploaded = await dw.call(`/api/v1/blobs/${a.sha256}`, { method: "PUT", key: dw.ownerKey, body: a.bytes, headers: { "Content-Length": String(a.size) } });
    expect(uploaded.status).toBe(201);
    const status = await client.call("get_version", { site: "pending-counts", version: pending.data.version.id });
    expect(status.isError).toBe(false);
    expect(status.data.version).toMatchObject({ status: "pending", live: false, fileCount: 3, totalBytes: 33 });
    expect(status.data.missing).toEqual([b.sha256]);
    // Accept the PublishResult upload block or the legacy uploads list;
    // R-05 requires usable items, not a new envelope for this read operation.
    const uploads = status.data.upload?.items ?? status.data.uploads;
    expect(uploads).toEqual([expect.objectContaining({ path: b.path, sha256: b.sha256 })]);
    expect((await dw.call("/s/pending-counts/index.html")).status).toBe(404);
    await uploadWithReturnedItem(uploads[0], b);
    const finalized = await client.call("finalize_version", { site: "pending-counts", versionId: pending.data.version.id });
    expect(finalized.isError).toBe(false);
    expect(finalized.data.status).toBe("live");
    const ready = await client.call("get_version", { site: "pending-counts", version: "live" });
    expect(ready.data.version).toMatchObject({ status: "ready", live: true, fileCount: 3, totalBytes: 33 });
    expect(ready.data.missing ?? []).toEqual([]);
    expect(ready.data.upload?.items ?? ready.data.uploads ?? []).toEqual([]);
  });

  it.each(["deploys", "versions"] as const)("REST /%s finalize returns 409 missing_blobs with upload items usable without a refresh", async (route) => {
    const { entry, result } = await pendingSite("missing-finalize");
    const early = await dw.json(`/api/v1/sites/missing-finalize/${route}/${result.version.id}/finalize`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("missing_blobs");
    expect(early.body.error.details.missing).toEqual([entry.sha256]);
    const uploads = early.body.error.details.upload?.items ?? early.body.error.details.uploads;
    expect(uploads).toEqual([expect.objectContaining({ path: entry.path, sha256: entry.sha256 })]);
    await uploadWithReturnedItem(uploads[0], entry);
    const finalized = await dw.json(`/api/v1/sites/missing-finalize/${route}/${result.version.id}/finalize`, {
      method: "POST", key: dw.ownerKey,
    });
    expect(finalized.status).toBe(200);
    expect(await (await dw.call("/s/missing-finalize/data.txt")).text()).toBe("pending bytes");
  });

  it("MCP finalize_version returns fresh upload items in its missing_blobs error", async () => {
    const { client, entry, result } = await pendingSite("mcp-missing");
    const early = await client.call("finalize_version", { site: "mcp-missing", versionId: result.version.id });
    expect(early.isError).toBe(true);
    expect(early.data.error.code).toBe("missing_blobs");
    const uploads = early.data.error.details.upload?.items ?? early.data.error.details.uploads;
    expect(uploads).toEqual([expect.objectContaining({ path: entry.path, sha256: entry.sha256 })]);
    await uploadWithReturnedItem(uploads[0], entry);
    const finalized = await client.call("finalize_version", { site: "mcp-missing", versionId: result.version.id });
    expect(finalized.isError).toBe(false);
    expect(finalized.data.status).toBe("live");
    expect(await (await dw.call("/s/mcp-missing/data.txt")).text()).toBe("pending bytes");
  });
});
