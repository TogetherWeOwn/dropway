import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { ALL_SCOPES, clearLiveMemoryCache, defaultIdentity, runCleanup, type ConfigOverrides, type MemberPrincipal } from "@dropway/core";
import type { ServerBindings } from "@dropway/server";
import { expect } from "vitest";
import { form, freshInstance, jsonBody, type Instance } from "./helpers";

export const START = Date.parse("2030-01-15T12:00:00.000Z");
export const YEAR_END = Date.parse("2031-01-15T12:00:00.000Z");
export const DAY = 86_400_000;
export const OTHER = { "X-Permanence-Tenant": "other" };

// Only identity is supplied by the fixture. Routing, services and emulated
// D1/R2/KV stay real. The second tenant exists only in disposable test storage.
export async function permanenceInstance(config: ConfigOverrides = {}) {
  const other: MemberPrincipal = {
    kind: "member", tenantId: "permanence-other-tenant", memberId: "permanence-other-member",
    role: "owner", scopes: ALL_SCOPES, keyId: null, siteId: null, via: "test-session", ip: "192.0.2.2",
  };
  const dw = await freshInstance(config, { adapters: { identity: {
    resolve(request, dc) {
      return request.headers.get("X-Permanence-Tenant") === "other" ? Promise.resolve(other) : defaultIdentity.resolve(request, dc);
    },
  } } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").bind(other.tenantId, "Disposable other tenant", Date.now()),
    env.DB.prepare("INSERT INTO members (id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)").bind(other.memberId, other.tenantId, "owner", Date.now()),
  ]);
  return dw;
}

export async function create(dw: Instance, slug?: string, other = false) {
  const out = await dw.json("/api/v1/sites", {
    ...jsonBody(slug ? { slug } : {}), key: other ? null : dw.ownerKey,
    ...(other ? { headers: { ...OTHER, "Content-Type": "application/json" } } : {}),
  });
  expect(out.status, "fixture: create site").toBe(201);
  return out.body.site as { id: string; slug: string };
}

export async function publish(dw: Instance, slug: string, text = "original-site-bytes") {
  const out = await dw.json("/api/v1/publish", {
    method: "POST", key: dw.ownerKey, body: form({ "index.txt": text, "deep/space name.txt": text }, { slug }),
  });
  expect([200, 201], "fixture: publish").toContain(out.status);
  return out.body;
}

export async function rename(dw: Instance, slug: string, newSlug: string, other = false) {
  return dw.json(`/api/v1/sites/${slug}/rename`, {
    ...jsonBody({ newSlug }), key: other ? null : dw.ownerKey,
    ...(other ? { headers: { ...OTHER, "Content-Type": "application/json" } } : {}),
  });
}

export async function cleanup(dw: Instance) {
  const ctx = createExecutionContext();
  const report = await runCleanup(dw.dropway.context(env as unknown as ServerBindings, ctx), Date.now());
  await waitOnExecutionContext(ctx);
  clearLiveMemoryCache();
  return report;
}

export async function retire(dw: Instance, slug: string, cause: "delete" | "expiry") {
  if (cause === "delete") {
    expect((await dw.json(`/api/v1/sites/${slug}`, { method: "DELETE", key: dw.ownerKey })).status, "fixture: delete").toBe(200);
  } else {
    // The public model has expires_at, but there is no chosen-name expiry API.
    // Seed only that lifecycle input; the real cleanup creates the tombstone.
    await env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.now() - 1, slug).run();
    expect((await cleanup(dw)).expiredSites, "fixture: expire exactly one site").toBe(1);
  }
}

export function reserved(out: { status: number; body: any }) {
  expect.soft(out.status, "another tenant cannot take a held slug").toBe(409);
  expect.soft(out.body?.error?.code).toBe("slug_reserved");
  expect.soft(out.body?.error?.hint, "tell the caller how to recover").toEqual(expect.any(String));
  expect.soft(out.body?.error?.hint ?? "").toMatch(/choose|another|different|new|wait|until|reclaim|owner|operator|contact|use|try|retry/i);
}
