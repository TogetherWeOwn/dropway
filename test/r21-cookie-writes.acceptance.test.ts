import { describe, expect, it } from "vitest";
import {
  anonymousSite, digest, env, freshInstance, ORIGIN, pageForms, SAME_ORIGIN,
  signedIn, siteRow, storedRows, type Instance,
} from "./r21-helpers";

const WORKER_APP = "https://dropway.fixture.workers.dev";
const WORKER_SIBLING = "https://dropway-sites.fixture.workers.dev";
const DENIED: Array<{ name: string; headers: Record<string, string> }> = [
  { name: "hostile cross-site", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } },
  { name: "same-site cross-origin sibling", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-site" } },
  { name: "opaque sandbox origin", headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } },
  { name: "Origin absent independently", headers: { "Sec-Fetch-Site": "same-origin" } },
  { name: "Origin mismatch independently", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" } },
  { name: "Origin sibling independently", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-origin" } },
  { name: "Origin suffix trick", headers: { Origin: "https://dropway.test.attacker.example", "Sec-Fetch-Site": "same-origin" } },
  { name: "Origin wrong scheme", headers: { Origin: "http://dropway.test", "Sec-Fetch-Site": "same-origin" } },
  { name: "Origin wrong port", headers: { Origin: "https://dropway.test:444", "Sec-Fetch-Site": "same-origin" } },
  { name: "Fetch Metadata absent independently", headers: { Origin: ORIGIN } },
  ...["same-site", "cross-site", "none", "invalid", "Same-Origin"].map((value) => ({
    name: `Fetch Metadata ${value} independently`, headers: { Origin: ORIGIN, "Sec-Fetch-Site": value },
  })),
];

const ACTIONS = ["claim page submission", "logout", "revoke own session"] as const;
type Action = typeof ACTIONS[number];

async function sessionRows(cookie: string) {
  const hash = await digest(cookie.slice(cookie.indexOf("=") + 1));
  return (await storedRows()).filter(({ row }) => Object.values(row).includes(hash));
}

async function fixture(action: Action, origin = ORIGIN) {
  const raw = await freshInstance({ appOrigin: origin, anonymous: { enabled: true } });
  const dw: Instance = {
    ...raw,
    call: (path, init) => raw.call(path, { ...init, origin }),
    json: (path, init) => raw.json(path, { ...init, origin }),
  };
  const active = await signedIn(dw, undefined, origin);
  let path: string;
  let method: string;
  let body: URLSearchParams | undefined;
  let targetCookie = active.cookie;
  let readState: () => Promise<unknown>;
  let assertSuccess: () => Promise<void>;

  if (action === "claim page submission") {
    const site = await anonymousSite(dw);
    // A fragment is browser-side proof, never sent on this GET. Read the real
    // page's form target rather than installing or inventing an app handler.
    const page = await dw.call(`/claim?slug=${site.slug}`, { headers: { Cookie: active.cookie } });
    expect(page.status).toBe(200);
    const forms = await pageForms(page);
    const claim = forms.find((form) => form.method.toLowerCase() === "post" && "claimToken" in form.fields);
    expect(claim, "the actual signed-in claim page must expose its claim operation").toBeTruthy();
    const target = new URL(claim!.action || `/claim?slug=${site.slug}`, origin);
    expect(target.origin).toBe(origin);
    path = target.href;
    method = "POST";
    body = new URLSearchParams({ ...claim!.fields, claimToken: site.token });
    readState = () => siteRow(site.slug);
    assertSuccess = async () => {
      const row = await siteRow(site.slug);
      const tenant = await env.DB.prepare("SELECT id FROM tenants").first<{ id: string }>();
      expect(tenant).toBeTruthy();
      expect(row?.tenant_id).toBe(tenant!.id);
      expect(row?.claim_token_hash).toBeNull();
      expect(row?.expires_at).toBeNull();
    };
  } else {
    method = action === "logout" ? "POST" : "DELETE";
    path = "/api/v1/auth/logout";
    if (action === "revoke own session") {
      const victim = await signedIn(dw, undefined, origin);
      const victimId = victim.sessions.find((session) => !active.sessions.some((prior) => prior.id === session.id))?.id;
      expect(victimId).toBeTruthy();
      path = `/api/v1/auth/sessions/${victimId}`;
      targetCookie = victim.cookie;
    }
    readState = () => sessionRows(targetCookie);
    expect((await readState() as unknown[]).length, "the target has real hashed session state in D1").toBeGreaterThan(0);
    assertSuccess = async () => {
      expect((await dw.call("/api/v1/auth/sessions", { headers: { Cookie: targetCookie } })).status).toBe(401);
      if (action === "revoke own session") {
        expect((await dw.call("/api/v1/auth/sessions", { headers: { Cookie: active.cookie } })).status).toBe(200);
      }
    };
  }

  const write = (headers: Record<string, string>, cookie: string | null = active.cookie) => dw.call(path, {
    method, body, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
  });
  return { dw, active, targetCookie, readState, assertSuccess, write };
}

// Each case starts at the actual link issuer and checks an actual route and D1.
// No fake cookie/session issuer and no bearer Authorization on the tested writes.
// On the pre-feature base these fail at the named missing-issuer assertion: the
// downstream matrix is specified, NOT claimed executed or passing yet.
describe.each(ACTIONS)("R-21 real-cookie write boundary: %s", (action) => {
  it.each(DENIED)("denies $name without changing target state", async ({ headers }) => {
    const f = await fixture(action);
    const before = await f.readState();
    const response = await f.write(headers);
    expect.soft(response.status).toBe(403);
    expect(await f.readState()).toEqual(before);
    expect((await f.dw.call("/api/v1/auth/sessions", { headers: { Cookie: f.targetCookie } })).status).toBe(200);
  });

  it("denies a real workers.dev same-site sibling without mutation", async () => {
    const f = await fixture(action, WORKER_APP);
    const before = await f.readState();
    const response = await f.write({ Origin: WORKER_SIBLING, "Sec-Fetch-Site": "same-site" });
    expect.soft(response.status).toBe(403);
    expect(await f.readState()).toEqual(before);
  });

  it("requires exact workers.dev Origin even when Fetch Metadata says same-origin", async () => {
    const f = await fixture(action, WORKER_APP);
    const before = await f.readState();
    const response = await f.write({ Origin: WORKER_SIBLING, "Sec-Fetch-Site": "same-origin" });
    expect.soft(response.status).toBe(403);
    expect(await f.readState()).toEqual(before);
  });

  it("positive control: real cookie + exact Origin + same-origin metadata changes intended state", async () => {
    const f = await fixture(action);
    const before = await f.readState();
    const response = await f.write(SAME_ORIGIN);
    expect([200, 204, 303]).toContain(response.status);
    expect(await f.readState()).not.toEqual(before);
    await f.assertSuccess();
  });

  it("positive control: the workers.dev app's exact Origin authorizes its real cookie", async () => {
    const f = await fixture(action, WORKER_APP);
    const before = await f.readState();
    const response = await f.write({ Origin: WORKER_APP, "Sec-Fetch-Site": "same-origin" });
    expect([200, 204, 303]).toContain(response.status);
    expect(await f.readState()).not.toEqual(before);
    await f.assertSuccess();
  });

  it.each(["missing", "invalid", "revoked"])("valid browser headers do not authorize a %s session", async (kind) => {
    const f = await fixture(action);
    let cookie: string | null = kind === "missing" ? null : "__Host-dw_session=not-a-real-session";
    if (kind === "revoked") {
      const logout = await f.dw.call("/api/v1/auth/logout", { method: "POST", headers: { ...SAME_ORIGIN, Cookie: f.active.cookie } });
      expect([200, 204, 303]).toContain(logout.status);
      cookie = f.active.cookie;
    }
    const before = await f.readState();
    const response = await f.write(SAME_ORIGIN, cookie);
    if (action === "claim page submission" && response.status === 303) {
      const destination = new URL(response.headers.get("Location")!, ORIGIN);
      expect(destination.origin).toBe(ORIGIN);
      expect(destination.pathname).toBe("/login");
    } else {
      expect.soft(response.status).toBe(401);
    }
    expect(await f.readState()).toEqual(before);
  });
});

describe("R-21 signed-in claim proof", () => {
  it("requires the actual anonymous site's proof even with a live session", async () => {
    const raw = await freshInstance({ anonymous: { enabled: true } });
    const { cookie } = await signedIn(raw);
    const site = await anonymousSite(raw);
    const other = await anonymousSite(raw);
    const page = await raw.call(`/claim?slug=${site.slug}`, { headers: { Cookie: cookie } });
    const claim = (await pageForms(page)).find((form) => form.method.toLowerCase() === "post" && "claimToken" in form.fields);
    expect(claim).toBeTruthy();
    const target = new URL(claim!.action || `/claim?slug=${site.slug}`, ORIGIN);
    expect(target.origin).toBe(ORIGIN);
    const before = await siteRow(site.slug);
    for (const token of ["", "dwc_invalid-proof", other.token]) {
      const response = await raw.call(target.href, {
        method: "POST", headers: { ...SAME_ORIGIN, Cookie: cookie },
        body: new URLSearchParams({ ...claim!.fields, claimToken: token }),
      });
      expect([400, 403, 404]).toContain(response.status);
      expect(await siteRow(site.slug)).toEqual(before);
    }
  });
});
