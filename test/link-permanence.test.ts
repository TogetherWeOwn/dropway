import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { ConfigOverrides } from "@dropway/core";
import { jsonBody, ORIGIN } from "./helpers";
import { connectMcp } from "./mcp-helpers";
import { cleanup, create, DAY, OTHER, permanenceInstance, publish, rename, reserved, retire, START, YEAR_END } from "./link-permanence-fixture";

// Independent R-59 acceptance: intentionally RED until the public core implements
// link permanence. No runtime mocks, invented retention config or release route.
// Mutation targets: free an alias early; lose path/query; redirect through chains;
// forget a tombstone during purge; confuse tenant ownership or version identity.
// Missing config/operator/preview seams are also documented in the handoff.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const modes: Array<{ name: string; config: ConfigOverrides; url: (slug: string) => string }> = [
  { name: "shared-origin path", config: {}, url: (slug) => `${ORIGIN}/s/${slug}` },
  { name: "separate-origin path", config: { sitesOrigin: "https://files.test" }, url: (slug) => `https://files.test/${slug}` },
  { name: "subdomain", config: { sitesMode: "subdomain", sitesDomain: "sites.test" }, url: (slug) => `https://${slug}.sites.test` },
];

for (const mode of modes) {
  describe(`rename permanence: ${mode.name}`, () => {
    it.each(["GET", "HEAD"])("%s old name returns 308 with encoded path and repeated query intact", async (method) => {
      const dw = await permanenceInstance(mode.config);
      await publish(dw, "permanent-alpha");
      const tail = "/deep/space%20name.txt?raw=1&x=one%2Ftwo&x=three+four";
      // Warm the real old-name manifest before renaming.
      const warm = await dw.call(`${mode.url("permanent-alpha")}${tail}`);
      expect(warm.status, "fixture: old URL works before rename").toBe(200);
      await warm.text();
      expect((await rename(dw, "permanent-alpha", "permanent-beta")).status).toBe(200);
      const out = await dw.call(`${mode.url("permanent-alpha")}${tail}`, { method });
      expect.soft(out.status).toBe(308);
      expect.soft(out.headers.get("location")).toBe(`${mode.url("permanent-beta")}${tail}`);
      await out.text();
      const canonical = await dw.call(`${mode.url("permanent-beta")}/index.txt`);
      expect(canonical.status).toBe(200);
      expect(await canonical.text()).toBe("original-site-bytes");
    });

    it("a -> b -> c redirects both prior names directly to c", async () => {
      const dw = await permanenceInstance(mode.config);
      await publish(dw, "chain-alpha");
      expect((await rename(dw, "chain-alpha", "chain-beta")).status).toBe(200);
      expect((await rename(dw, "chain-beta", "chain-gamma")).status).toBe(200);
      for (const slug of ["chain-alpha", "chain-beta"]) {
        const out = await dw.call(`${mode.url(slug)}/index.txt?download=1&x=%2B`);
        expect.soft(out.status, slug).toBe(308);
        expect.soft(out.headers.get("location"), slug).toBe(`${mode.url("chain-gamma")}/index.txt?download=1&x=%2B`);
        await out.text();
      }
      const canonical = await dw.call(`${mode.url("chain-gamma")}/index.txt`);
      expect(await canonical.text()).toBe("original-site-bytes");
    });

    it("keeps the old URL bound just before twelve calendar months", async () => {
      const dw = await permanenceInstance(mode.config);
      await publish(dw, "long-alpha");
      expect((await rename(dw, "long-alpha", "long-beta")).status).toBe(200);
      vi.setSystemTime(YEAR_END - 1);
      await cleanup(dw);
      const out = await dw.call(`${mode.url("long-alpha")}/index.txt?raw=1`);
      expect.soft(out.status).toBe(308);
      expect.soft(out.headers.get("location")).toBe(`${mode.url("long-beta")}/index.txt?raw=1`);
      await out.text();
    });

    it("deleted non-live version URL answers 410, not live bytes or a generic 404", async () => {
      const dw = await permanenceInstance(mode.config);
      await publish(dw, "version-owner", "old-version-bytes");
      const old = await dw.json("/api/v1/sites/version-owner/versions/v1", { key: dw.ownerKey });
      expect(old.status, "fixture: v1 exists").toBe(200);
      await publish(dw, "version-owner", "current-version-bytes");
      expect((await dw.json(`/api/v1/sites/version-owner/versions/${old.body.version.id}`, { method: "DELETE", key: dw.ownerKey })).status).toBe(200);
      const out = await dw.call(`${mode.url("version-owner--v1")}/index.txt`, { key: dw.ownerKey });
      expect.soft(out.status).toBe(410);
      expect.soft(await out.text()).not.toContain("current-version-bytes");
      const live = await dw.call(`${mode.url("version-owner")}/index.txt`);
      expect(live.status).toBe(200);
      expect(await live.text()).toBe("current-version-bytes");
    });

    it("a same-tenant new site at a deleted slug never revives the old version URL", async () => {
      const dw = await permanenceInstance(mode.config);
      await publish(dw, "version-reused", "deleted-site-bytes");
      await retire(dw, "version-reused", "delete");
      await publish(dw, "version-reused", "different-site-bytes");
      const out = await dw.call(`${mode.url("version-reused--v1")}/index.txt`, { key: dw.ownerKey });
      expect.soft(out.status).toBe(410);
      const body = await out.text();
      expect.soft(body).not.toContain("different-site-bytes");
      expect.soft(body).not.toContain("deleted-site-bytes");
    });
  });
}

function deadline(value: unknown) {
  expect(value, "rename must expose redirectUntil").toEqual(expect.any(String));
  const parsed = Date.parse(value as string);
  expect(Number.isFinite(parsed)).toBe(true);
  expect(parsed).toBeGreaterThanOrEqual(YEAR_END);
}

describe("rename response and ownership", () => {
  it("REST exposes oldSlug and a redirectUntil at least twelve months away", async () => {
    const dw = await permanenceInstance();
    await create(dw, "response-alpha");
    const out = await rename(dw, "response-alpha", "response-beta");
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ renamed: true, oldSlug: "response-alpha", slug: "response-beta" });
    deadline(out.body.redirectUntil);
  });

  it("MCP rename_site exposes the same permanence deadline", async () => {
    const dw = await permanenceInstance();
    await create(dw, "tool-alpha");
    const mcp = await connectMcp(dw, dw.ownerKey);
    try {
      const out = await mcp.call("rename_site", { site: "tool-alpha", newSlug: "tool-beta" });
      expect(out.isError).toBe(false);
      expect(out.data).toMatchObject({ renamed: true, oldSlug: "tool-alpha", slug: "tool-beta" });
      deadline(out.data.redirectUntil);
    } finally { await mcp.client.close(); }
  });

  it.each([
    { name: "one millisecond before", offset: -1, status: 409 },
    { name: "exactly at", offset: 0, status: 201 },
  ])("$name redirectUntil, cross-tenant create returns $status", async ({ offset, status }) => {
    const dw = await permanenceInstance();
    await create(dw, "deadline-alpha");
    const renamed = await rename(dw, "deadline-alpha", "deadline-beta");
    expect(renamed.status).toBe(200);
    deadline(renamed.body.redirectUntil);
    vi.setSystemTime(Date.parse(renamed.body.redirectUntil) + offset);
    await cleanup(dw);
    const out = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "deadline-alpha" }), headers: { ...OTHER, "Content-Type": "application/json" } });
    if (status === 409) reserved(out);
    else {
      expect(out.status).toBe(201);
      expect(out.body.site.slug).toBe("deadline-alpha");
    }
  });

  it.each(["create", "rename"])("another tenant cannot %s into the old alias", async (action) => {
    const dw = await permanenceInstance();
    await create(dw, "held-alpha");
    expect((await rename(dw, "held-alpha", "held-beta")).status).toBe(200);
    const other = await create(dw, "other-candidate", true);
    const out = action === "create"
      ? await dw.json("/api/v1/sites", { ...jsonBody({ slug: "held-alpha" }), headers: { ...OTHER, "Content-Type": "application/json" } })
      : await rename(dw, other.slug, "held-alpha", true);
    reserved(out);
    expect((await dw.json("/api/v1/sites/held-beta", { key: dw.ownerKey })).body.site.slug).toBe("held-beta");
  });
});

for (const cause of ["delete", "expiry"] as const) {
  for (const kind of ["chosen", "random"] as const) {
    describe(`${cause}: ${kind} name tombstones`, () => {
      it.each(["create", "rename"])("cross-tenant %s is refused immediately with actionable slug_reserved", async (action) => {
        const dw = await permanenceInstance();
        const site = await create(dw, kind === "chosen" ? "held-original" : undefined);
        const candidate = await create(dw, "other-candidate", true);
        await retire(dw, site.slug, cause);
        const out = action === "create"
          ? await dw.json("/api/v1/sites", { ...jsonBody({ slug: site.slug }), headers: { ...OTHER, "Content-Type": "application/json" } })
          : await rename(dw, candidate.slug, site.slug, true);
        reserved(out);
      });

      it("survives cleanup/purge until just before its minimum hold boundary", async () => {
        const dw = await permanenceInstance();
        const site = await create(dw, kind === "chosen" ? "held-boundary" : undefined);
        await retire(dw, site.slug, cause);
        vi.setSystemTime(START + 2 * 3_600_000);
        await cleanup(dw);
        vi.setSystemTime(kind === "chosen" ? YEAR_END - 1 : START + 90 * DAY - 1);
        await cleanup(dw);
        reserved(await dw.json("/api/v1/sites", { ...jsonBody({ slug: site.slug }), headers: { ...OTHER, "Content-Type": "application/json" } }));
      });

      it.each(["create", "rename"])("same tenant may reclaim by %s during the hold", async (action) => {
        const dw = await permanenceInstance();
        const site = await create(dw, kind === "chosen" ? "reclaim-original" : undefined);
        const candidate = await create(dw, "same-candidate");
        await retire(dw, site.slug, cause);
        const out = action === "create"
          ? await dw.json("/api/v1/sites", { ...jsonBody({ slug: site.slug }), key: dw.ownerKey })
          : await rename(dw, candidate.slug, site.slug);
        expect(out.status).toBe(action === "create" ? 201 : 200);
        expect(out.body.site.slug).toBe(site.slug);
        expect((await dw.json(`/api/v1/sites/${site.slug}`, { key: dw.ownerKey })).status).toBe(200);
      });
    });
  }
}

describe("actual anonymous expiry", () => {
  it("retains the generated name for a different owner after the real TTL elapses", async () => {
    const dw = await permanenceInstance({ anonymous: { enabled: true, ttlMs: 60_000 } });
    const anon = await dw.json("/api/v1/sites", jsonBody({}));
    expect(anon.status).toBe(201);
    expect(Date.parse(anon.body.expiresAt)).toBe(START + 60_000);
    vi.setSystemTime(START + 60_001);
    expect((await cleanup(dw)).expiredSites).toBe(1);
    reserved(await dw.json("/api/v1/sites", { ...jsonBody({ slug: anon.body.site.slug }), key: dw.ownerKey }));
  });
});

describe("existing isolation controls", () => {
  it("the second tenant is real, distinct, and cannot read or rename the first tenant's active site", async () => {
    const dw = await permanenceInstance();
    const own = await dw.json("/api/v1/me", { key: dw.ownerKey });
    const other = await dw.json("/api/v1/me", { headers: OTHER });
    expect(own.status).toBe(200);
    expect(other.status).toBe(200);
    expect(own.body.tenant.id).not.toBe(other.body.tenant.id);
    await create(dw, "private-active");
    expect((await dw.json("/api/v1/sites/private-active", { headers: OTHER })).status).toBe(404);
    expect((await rename(dw, "private-active", "stolen-active", true)).status).toBe(404);
    expect((await dw.json("/api/v1/sites/private-active", { key: dw.ownerKey })).status).toBe(200);
  });

  it("an occupied live slug cannot be created or renamed into by a different tenant", async () => {
    const dw = await permanenceInstance();
    await create(dw, "occupied-live");
    await create(dw, "other-live", true);
    const collision = await dw.json("/api/v1/sites", { ...jsonBody({ slug: "occupied-live" }), headers: { ...OTHER, "Content-Type": "application/json" } });
    expect(collision.status).toBe(409);
    expect(collision.body.error.code).toBe("slug_taken");
    expect((await rename(dw, "other-live", "occupied-live", true)).status).toBe(409);
  });

  it("an unauthenticated rename cannot change the active slug", async () => {
    const dw = await permanenceInstance();
    await create(dw, "protected-name");
    const out = await dw.json("/api/v1/sites/protected-name/rename", jsonBody({ newSlug: "unauthorized-name" }));
    expect(out.status).toBe(401);
    expect((await dw.json("/api/v1/sites/protected-name", { key: dw.ownerKey })).status).toBe(200);
  });

  it("the live version cannot be deleted", async () => {
    const dw = await permanenceInstance();
    await publish(dw, "live-protected");
    const v = await dw.json("/api/v1/sites/live-protected/versions/v1", { key: dw.ownerKey });
    expect(v.status).toBe(200);
    const out = await dw.json(`/api/v1/sites/live-protected/versions/${v.body.version.id}`, { method: "DELETE", key: dw.ownerKey });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("version_is_live");
    expect(await (await dw.call("/s/live-protected/index.txt")).text()).toBe("original-site-bytes");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM versions").first<{ n: number }>())?.n).toBe(1);
  });
});
