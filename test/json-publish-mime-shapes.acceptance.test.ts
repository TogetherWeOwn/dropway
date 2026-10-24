import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshInstance, jsonBody, type Instance } from "./helpers";

const invalidTypes: unknown[] = [5, true, {}, { toString: null }, 0, false];

// Compare persisted values, not counts: a refused request must not update an
// existing site, replace blob bytes, or invalidate its live cache.
async function storage() {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
  ).all<{ name: string }>();
  const rows: Record<string, string[]> = {};
  for (const { name } of tables.results) {
    const quoted = name.replace(/"/g, '""');
    const result = await env.DB.prepare(`SELECT * FROM "${quoted}"`).all();
    rows[name] = result.results.map((row) => JSON.stringify(row)).sort();
  }
  const objects = await env.FILES.list();
  expect(objects.truncated, "fixture fits in one R2 page").toBe(false);
  const blobs = await Promise.all(objects.objects.map(async ({ key }) => {
    const object = await env.FILES.get(key);
    expect(object).not.toBeNull();
    return {
      key, bytes: Array.from(new Uint8Array(await object!.arrayBuffer())),
      etag: object!.etag, uploaded: object!.uploaded,
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

function publish(instance: Instance, body: unknown) {
  return instance.json("/api/v1/publish", {
    key: instance.ownerKey, ...jsonBody(body),
  });
}

function clientError(result: { status: number; body: Record<string, any> }, path: string) {
  expect.soft(result.status, JSON.stringify(result.body)).toBe(400);
  const error = result.body.error;
  expect.soft(error?.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect.soft(error?.code).not.toBe("internal_error");
  expect.soft(error?.retryable).toBe(false);
  const fields = error?.details?.fields;
  expect.soft(fields, "client errors identify actionable fields").toBeInstanceOf(Array);
  if (!Array.isArray(fields)) return;
  const field = fields.find((item) =>
    String(item.path ?? item.field).replace(/\[(\d+)\]/g, ".$1") === path,
  );
  expect.soft(field, `diagnostics identify ${path}`).toBeDefined();
  expect.soft(field?.message ?? field?.problem).toMatch(/\S/);
}

async function seededInstance() {
  const instance = await freshInstance();
  // This also warms the API key's normal last_used_at write before snapshots.
  const seeded = await publish(instance, {
    slug: "mime-shape-seed", title: "Keep this title",
    files: [{ path: "keep.txt", content: "Keep these bytes" }],
  });
  expect(seeded.status, JSON.stringify(seeded.body)).toBe(201);
  expect(seeded.body.version.live).toBe(true);
  const before = await storage();
  expect(before.blobs.length).toBeGreaterThan(0);
  expect(before.cache.length).toBeGreaterThan(0);
  return { instance, before };
}

for (const target of ["new site", "existing site"] as const) {
  describe(`JSON publish MIME shape: ${target}`, () => {
    for (const contentType of invalidTypes) {
      it(`rejects ${JSON.stringify(contentType)} with a field error and unchanged storage`, async () => {
        const { instance, before } = await seededInstance();
        const existing = target === "existing site";
        const files = existing
          ? [
              { path: "first.txt", content: "Must not be partially stored" },
              { path: "second.txt", content: "Bad MIME shape", contentType },
            ]
          : [{ path: "index.txt", content: "Bad MIME shape", contentType }];
        const result = await publish(instance, {
          slug: existing ? "mime-shape-seed" : "mime-shape-new",
          title: "Must not replace the title", files,
        });
        expect(await storage(), "refused publish leaves D1, R2 and KV unchanged").toEqual(before);
        clientError(result, `files.${existing ? 1 : 0}.contentType`);
      });
    }
  });
}

async function successfulPublish(body: unknown, slug: string, path: string, content: string, contentType: string) {
  const instance = await freshInstance();
  const result = await publish(instance, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body.slug).toBe(slug);
  expect(result.body.files).toEqual([path]);
  expect(result.body.version.live).toBe(true);
  const file = await env.DB.prepare(
    "SELECT path, content_type FROM version_files WHERE version_id = ?",
  ).bind(result.body.version.id).first();
  expect(file).toEqual({ path, content_type: contentType });
  const response = await instance.call(`/s/${slug}/${path}?raw=1`);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(content);
}

describe("JSON publish MIME success and coercion controls", () => {
  for (const [label, mime, expected] of [
    ["string override", { contentType: "text/css" }, "text/css; charset=utf-8"],
    ["null", { contentType: null }, "application/json; charset=utf-8"],
    ["omitted", {}, "application/json; charset=utf-8"],
  ] as const) {
    it(`accepts ${label} MIME and serves the stored bytes`, async () => {
      const content = '{"ok":true}';
      await successfulPublish({
        slug: "mime-success", files: [{ path: "note.json", content, ...mime }],
      }, "mime-success", "note.json", content, expected);
    });
  }

  for (const [label, slug, path] of [
    ["numeric path", "scalar-path", 123],
    ["zero path", "scalar-zero", 0],
    ["boolean path", "scalar-boolean", false],
    ["numeric slug", 24680, "note.txt"],
    ["boolean slug", true, "note.txt"],
  ] as const) {
    it(`preserves successful ${label} coercion`, async () => {
      const content = "Scalar coercions still work";
      await successfulPublish({
        slug, files: [{ path, content, contentType: "text/plain" }],
      }, String(slug), String(path), content, "text/plain; charset=utf-8");
    });
  }
});
