import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, manifestEntry, type Instance } from "./helpers";

const poison = { toString: null };
const slug = "sibling-coercion";
const siteApi = `/api/v1/sites/${slug}`;
type Result = { status: number; body: Record<string, any> };

// Snapshot values, not counts: a refused request must not silently UPDATE settings.
async function storage() {
  const rows: Record<string, string[]> = {};
  for (const table of ["sites", "versions", "version_files", "blobs", "blob_scopes"]) {
    const result = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    rows[table] = result.results.map((row) => JSON.stringify(row)).sort();
  }
  const objects = await env.FILES.list();
  expect(objects.truncated, "fixture fits in one R2 page").toBe(false);
  const blobs = await Promise.all(objects.objects.map(async ({ key }) => {
    const object = await env.FILES.get(key);
    expect(object).not.toBeNull();
    return {
      key, bytes: Array.from(new Uint8Array(await object!.arrayBuffer())),
      version: object!.version, uploaded: object!.uploaded.toISOString(),
      httpMetadata: object!.httpMetadata, customMetadata: object!.customMetadata,
    };
  }));
  const keys = await env.CACHE.list();
  expect(keys.list_complete, "fixture fits in one KV page").toBe(true);
  const cache = await Promise.all(keys.keys.map(async (key) => ({
    ...key, value: await env.CACHE.get(key.name),
  })));
  return {
    rows, blobs: blobs.sort((a, b) => a.key.localeCompare(b.key)),
    cache: cache.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function fixture() {
  const instance = await freshInstance();
  const seeded = await instance.json("/api/v1/publish", {
    key: instance.ownerKey,
    ...jsonBody({ slug, title: "Original title", description: "Original description", files: [{ path: "index.txt", content: "seed bytes" }] }),
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
  expect(seeded.body.version.live).toBe(true);
  const snapshot = await storage();
  expect(snapshot.blobs.length, "refusal checks preserve nonempty R2").toBeGreaterThan(0);
  expect(snapshot.cache.length, "refusal checks preserve nonempty KV").toBeGreaterThan(0);
  return { instance, versionId: seeded.body.version.id as string };
}

function clientError(result: Result, code?: string) {
  expect(result.status, JSON.stringify(result.body)).toBe(400);
  expect(result.body.error.code).not.toBe("internal_error");
  if (code) expect(result.body.error.code).toBe(code);
  expect(result.body.error.retryable).toBe(false);
}

function fieldError(result: Result, path: string, code?: string) {
  clientError(result, code);
  expect(result.body.error.hint).toEqual(expect.any(String));
  expect(result.body.error.hint.trim().length).toBeGreaterThan(0);
  expect(result.body.error.details?.fields).toBeInstanceOf(Array);
  const diagnostics = result.body.error.details.fields.map((field: Record<string, any>) => ({
    path: String(field.path ?? field.field).replace(/\[(\d+)\]/g, ".$1"),
    message: field.message ?? field.problem,
  }));
  const diagnostic = diagnostics.find((field: { path: string }) => field.path === path);
  expect(diagnostic, `actionable diagnostic for ${path}`).toBeDefined();
  expect(diagnostic.message).toEqual(expect.any(String));
  expect(diagnostic.message.trim().length).toBeGreaterThan(0);
}

async function rejectedWithoutMutation(request: () => Promise<Result>) {
  const before = await storage();
  const result = await request();
  expect(await storage(), `rejected request leaves D1/R2/KV unchanged: ${JSON.stringify(result.body)}`).toEqual(before);
  return result;
}

function post(instance: Instance, path: string, body: unknown) {
  return instance.json(path, { key: instance.ownerKey, ...jsonBody(body) });
}

function access(instance: Instance, body: unknown, target = siteApi) {
  return instance.json(`${target}/access`, { key: instance.ownerKey, ...jsonBody(body), method: "PUT" });
}

async function validManifest() {
  const { bytes: _bytes, ...entry } = await manifestEntry("next.txt", "next bytes");
  return entry;
}

describe("F1 sibling coercion failures", () => {
  it("rejects create-site slug poison with a field diagnostic and no writes", async () => {
    const { instance } = await fixture();
    const entry = await validManifest();
    const result = await rejectedWithoutMutation(() => post(instance, "/api/v1/sites", {
      slug: poison, title: "Must not be created", files: [entry],
    }));
    fieldError(result, "slug");
  });

  it("rejects JSON-publish slug poison with a field diagnostic and no writes", async () => {
    const { instance } = await fixture();
    const result = await rejectedWithoutMutation(() => post(instance, "/api/v1/publish", {
      slug: poison, title: "Must not be created", files: [{ path: "new.txt", content: "must not be stored" }],
    }));
    fieldError(result, "slug");
  });

  it("rejects JSON-publish path poison after a valid entry without changing an existing site", async () => {
    const { instance } = await fixture();
    const result = await rejectedWithoutMutation(() => post(instance, "/api/v1/publish", {
      slug, title: "Must not replace title", files: [
        { path: "first.txt", content: "must not be stored" },
        { path: poison, content: "must not be stored either" },
      ],
    }));
    fieldError(result, "files.1.path");
  });

  it("rejects access mode poison with a field diagnostic and no writes", async () => {
    const { instance } = await fixture();
    const result = await rejectedWithoutMutation(() => access(instance, { mode: poison, password: "valid-password" }));
    fieldError(result, "mode");
  });
});

// Keep legacy successful coercions: hardening must not become strict type rejection.
describe("F1 legacy controls and first semantic errors", () => {
  for (const value of [24680, true, "  Mixed-Name  "]) {
    it(`preserves create-site slug coercion for ${JSON.stringify(value)}`, async () => {
      const instance = await freshInstance();
      const result = await post(instance, "/api/v1/sites", { slug: value, title: "Created" });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const canonical = String(value).trim().toLowerCase();
      expect(result.body.site.slug).toBe(canonical);
      expect(await env.DB.prepare("SELECT slug, title FROM sites WHERE slug = ?").bind(canonical).first())
        .toEqual({ slug: canonical, title: "Created" });
    });
  }

  for (const [siteName, path] of [[13579, 123], [true, true], ["  Publish-Control  ", "nested/file.txt"]] as const) {
    it(`preserves JSON-publish slug/path coercions for ${JSON.stringify([siteName, path])}`, async () => {
      const instance = await freshInstance();
      const result = await post(instance, "/api/v1/publish", {
        slug: siteName, files: [{ path, content: "published control" }],
      });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const canonical = String(siteName).trim().toLowerCase();
      expect(result.body.slug).toBe(canonical);
      expect(result.body.version.live).toBe(true);
      expect(await env.DB.prepare("SELECT path FROM version_files WHERE version_id = ?")
        .bind(result.body.version.id).first()).toEqual({ path: String(path) });
      const served = await instance.call(`/s/${canonical}/${String(path)}?raw=1`);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("published control");
    });
  }

  for (const arrayMode of [false, true]) {
    it(`preserves ${arrayMode ? "array-coerced" : "string"} password/public access modes`, async () => {
      const { instance } = await fixture();
      const protectedSite = await access(instance, { mode: arrayMode ? ["password"] : "password", password: "valid-password" });
      expect(protectedSite.status, JSON.stringify(protectedSite.body)).toBe(200);
      expect(protectedSite.body.access.mode).toBe("password");
      expect(protectedSite.body.site.settings.passwordProtected).toBe(true);
      const protectedRow = await env.DB.prepare("SELECT password_hash FROM sites WHERE slug = ?")
        .bind(slug).first<{ password_hash: string }>();
      expect(protectedRow?.password_hash).toEqual(expect.any(String));
      expect(protectedRow?.password_hash).not.toBe("valid-password");
      const publicSite = await access(instance, { mode: arrayMode ? ["public"] : "public" });
      expect(publicSite.status, JSON.stringify(publicSite.body)).toBe(200);
      expect(publicSite.body.access.mode).toBe("public");
      expect(publicSite.body.site.settings.passwordProtected).toBe(false);
      expect(await env.DB.prepare("SELECT password_hash FROM sites WHERE slug = ?").bind(slug).first())
        .toEqual({ password_hash: null });
    });
  }

  it("preserves invalid slug before manifest semantics on create-site", async () => {
    const { instance } = await fixture();
    const result = await rejectedWithoutMutation(() => post(instance, "/api/v1/sites", {
      slug: "bad/name", files: [{ path: "../escape", size: -1, sha256: "bad" }],
    }));
    clientError(result, "invalid_slug");
  });

  for (const [first, code] of [
    [{ path: "../escape", content: "bad path" }, "invalid_path"],
    [{ path: "bad.txt", content: 42 }, "invalid_file"],
  ] as const) {
    it(`preserves first publish ${code} before a later poisoned path`, async () => {
      const { instance } = await fixture();
      const result = await rejectedWithoutMutation(() => post(instance, "/api/v1/publish", {
        slug, files: [first, { path: poison, content: "later poison" }],
      }));
      clientError(result, code);
    });
  }

  for (const mode of [42, true, "not-a-mode"]) {
    it(`preserves invalid_access_mode before site/password errors for ${JSON.stringify(mode)}`, async () => {
      const { instance } = await fixture();
      const result = await rejectedWithoutMutation(() => access(instance, { mode, password: poison }, "/api/v1/sites/missing-site"));
      clientError(result, "invalid_access_mode");
    });
  }

  it("preserves invalid_manifest for non-string contentType on an otherwise valid entry", async () => {
    const { instance } = await fixture();
    const entry = await validManifest();
    const result = await rejectedWithoutMutation(() => post(instance, `${siteApi}/deploys`, {
      files: [{ ...entry, contentType: 42 }],
    }));
    fieldError(result, "files.0.contentType", "invalid_manifest");
  });
});

describe("F2 deploy settings and metadata ordering", () => {
  for (const name of ["message", "baseVersionId"] as const) {
    it(`rejects poisoned ${name} before persisting combined settings`, async () => {
      const { instance, versionId } = await fixture();
      const entry = await validManifest();
      const result = await rejectedWithoutMutation(() => post(instance, `${siteApi}/deploys`, {
        files: [entry], title: "Must not replace title", description: "Must not replace description", spa: true,
        message: "valid message", baseVersionId: versionId, [name]: poison,
      }));
      fieldError(result, name);
      expect(await env.DB.prepare("SELECT title, description, spa, current_version_id FROM sites WHERE slug = ?").bind(slug).first())
        .toEqual({ title: "Original title", description: "Original description", spa: 0, current_version_id: versionId });
    });
  }

  for (const message of [1234, "release text"]) {
    it(`accepts combined settings and valid metadata with ${typeof message} message`, async () => {
      const { instance, versionId } = await fixture();
      const entry = await validManifest();
      const result = await post(instance, `${siteApi}/deploys`, {
        files: [entry], title: "Updated title", description: "Updated description", spa: true,
        message, baseVersionId: versionId,
      });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(result.body.unchanged).toBe(false);
      expect(result.body.deploy.status).toBe("pending");
      expect(result.body.missing).toEqual([entry.sha256]);
      expect(await env.DB.prepare("SELECT title, description, spa, current_version_id FROM sites WHERE slug = ?").bind(slug).first())
        .toEqual({ title: "Updated title", description: "Updated description", spa: 1, current_version_id: versionId });
      expect(await env.DB.prepare("SELECT message, base_version_id FROM versions WHERE id = ?")
        .bind(result.body.deploy.id).first()).toEqual({ message: String(message), base_version_id: versionId });
      expect(await env.DB.prepare("SELECT path, size, sha256 FROM version_files WHERE version_id = ?")
        .bind(result.body.deploy.id).first()).toEqual({ path: entry.path, size: entry.size, sha256: entry.sha256 });
    });
  }
});
