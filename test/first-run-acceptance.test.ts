/**
 * R-16: first-run HTTP/HTML contracts, derived from ROADMAP and SPEC 12.1/12.5.
 * Run: npx vitest run test/first-run-acceptance.test.ts
 *
 * Uses real workerd, D1, R2 and KV. No implementation helpers or UI source reads.
 * These are intentionally failing-first tests; the Builder owns implementation.
 * This does NOT prove browser-script storage/network behavior, fresh-account
 * provisioning, or a week of CLI/MCP use. Those require real browser/account/run
 * evidence, including timings, manual steps and the five most frequent errors.
 */
import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDropway, type Dropway, type ServerBindings } from "@dropway/server";
import { version } from "../package.json";
import { BOOTSTRAP, ORIGIN } from "./helpers";

interface Input {
  name: string;
  type: string;
  value: string | null;
  autocomplete: string | null;
}
interface HtmlForm {
  action: string | null;
  method: string;
  inputs: Input[];
}

// Parse the actual response as HTML, not the implementation's template text.
async function formsIn(html: string): Promise<HtmlForm[]> {
  const forms: HtmlForm[] = [];
  await new HTMLRewriter()
    .on("form", {
      element(el) {
        forms.push({ action: el.getAttribute("action"), method: el.getAttribute("method") ?? "get", inputs: [] });
      },
    })
    .on("form input", {
      element(el) {
        forms.at(-1)!.inputs.push({
          name: el.getAttribute("name") ?? "",
          type: el.getAttribute("type") ?? "text",
          value: el.getAttribute("value"),
          autocomplete: el.getAttribute("autocomplete"),
        });
      },
    })
    .transform(new Response(html))
    .text();
  return forms;
}

function setupForm(forms: HtmlForm[]) {
  return forms.find((form) => form.inputs.some((input) => input.type === "password") && form.inputs.some((input) => input.type === "email"));
}

let dropway: Dropway;
let bindings: ServerBindings & { BUILD_SHA?: string };
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  dropway = createDropway();
  bindings = { ...env } as unknown as typeof bindings;
  delete bindings.BUILD_SHA;
});

async function call(path: string, init: RequestInit = {}, app = dropway, vars = bindings) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(new URL(path, ORIGIN), { ...init, redirect: "manual" }), vars, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function setup(secret = BOOTSTRAP, email = "first-owner@example.com") {
  return call("/api/v1/setup", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email }),
  });
}

async function ownerKey() {
  const res = await setup();
  expect(res.status).toBe(201);
  const result = await res.json<{ apiKey: { key: string } }>();
  expect(result.apiKey.key).toMatch(/^dw_/);
  return result.apiKey.key;
}

async function counts() {
  return {
    tenants: (await env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{ n: number }>())!.n,
    members: (await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first<{ n: number }>())!.n,
    keys: (await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first<{ n: number }>())!.n,
  };
}

describe("R-16 first-run page", () => {
  it("keeps the existing /login setup form available as a control for the HTML parser", async () => {
    const res = await call("/login");
    expect(res.status).toBe(200);
    const form = setupForm(await formsIn(await res.text()));
    expect(form).toBeDefined();
    expect(form!.inputs.some((input) => input.name === "email" && input.type === "email")).toBe(true);
    const secret = form!.inputs.find((input) => input.type === "password")!;
    expect(secret.value ?? "").toBe("");
    expect(secret.autocomplete).toBe("off");
  });

  it("renders the bootstrap-secret and email form directly on an unconfigured /", async () => {
    const res = await call("/", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const form = setupForm(await formsIn(await res.text()));
    expect(form, "A link to /login is not the required first-run form on /").toBeDefined();
    expect(form!.inputs.some((input) => input.name === "email" && input.type === "email")).toBe(true);
    const secret = form!.inputs.find((input) => input.type === "password")!;
    expect(secret.name).toBeTruthy();
    expect(secret.value ?? "").toBe("");
    expect(secret.autocomplete).toBe("off");
  });

  it("never falls back to a GET or a sites-origin submission before scripts load", async () => {
    const app = createDropway({ config: { appOrigin: ORIGIN, sitesOrigin: "https://sites.example" } });
    const res = await call("/", {}, app);
    const form = setupForm(await formsIn(await res.text()));
    expect(form, "First-run form must exist to check its submission destination").toBeDefined();
    expect(form!.method.toLowerCase()).toBe("post");
    const action = new URL(form!.action ?? "/", ORIGIN);
    expect(action.origin).toBe(ORIGIN);
    expect(action.search).toBe("");
    expect(action.hash).toBe("");
    expect(res.headers.get("content-security-policy")).toMatch(/(?:^|;)\s*form-action\s+'self'\s*(?:;|$)/);
  });

  it("does not prefill or expose the configured bootstrap secret in public pages", async () => {
    for (const path of ["/", "/login", "/health"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(BOOTSTRAP);
      expect(res.headers.get("set-cookie") ?? "", path).not.toContain(BOOTSTRAP);
      expect(res.headers.get("location") ?? "", path).not.toContain(BOOTSTRAP);
    }
  });

  it("stops offering first-run setup after owner creation, including in a new app instance", async () => {
    await ownerKey();
    const res = await call("/", {}, createDropway());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(setupForm(await formsIn(html))).toBeUndefined();
    expect(html).not.toContain(BOOTSTRAP);
  });

  it("provides the post-setup /connect page with this instance's MCP endpoint", async () => {
    await ownerKey();
    const res = await call("/connect", { headers: { Accept: "text/html" } });
    expect(res.status, "/connect is the next step after the one-time key display").toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(`${ORIGIN}/mcp`);
    expect(html).not.toContain(BOOTSTRAP);
  });
});

describe("R-16 owner creation controls", () => {
  it("accepts a bootstrap secret and email and returns an immediately usable owner key", async () => {
    const key = await ownerKey();
    const headers = { Authorization: `Bearer ${key}` };
    const me = await call("/api/v1/me", { headers });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ member: { role: "owner", email: "first-owner@example.com" } });
    // Full-scope means usable permissions, not just a scopes string in setup JSON.
    expect((await call("/api/v1/keys", { headers })).status).toBe(200);
    expect((await call("/api/v1/members", { headers })).status).toBe(200);
    const publish = await call("/api/v1/publish", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ path: "index.html", content: "<h1>First publish</h1>" }] }),
    });
    expect(publish.status).toBe(201);
    const result = await publish.json<{ url: string }>();
    const live = await call(result.url);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain("<h1>First publish</h1>");
  });

  it("a wrong secret creates nothing and leaves a valid first setup possible", async () => {
    const wrong = await setup("not-the-bootstrap-secret");
    expect(wrong.status).toBe(401);
    expect(await counts()).toEqual({ tenants: 0, members: 0, keys: 0 });
    expect(await wrong.text()).not.toContain(BOOTSTRAP);
    await ownerKey();
    expect(await counts()).toEqual({ tenants: 1, members: 1, keys: 1 });
  });

  it("setup cannot be replayed to reveal the owner key or mint another one", async () => {
    const key = await ownerKey();
    const again = await setup();
    expect(again.status).toBe(409);
    expect(await again.text()).not.toContain(key);
    expect(await counts()).toEqual({ tenants: 1, members: 1, keys: 1 });
    for (const path of ["/", "/login", "/api/v1/keys"]) {
      const res = await call(path, { headers: { Authorization: `Bearer ${key}` } });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(key);
    }
  });
});

describe("R-16 health identity", () => {
  it("reports the package version and a dev build before setup, without authentication", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: true, version, build: "dev" });
  });

  it("reports the deploy-time BUILD_SHA rather than dev or an unrelated identifier", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const res = await call("/health", {}, createDropway(), { ...bindings, BUILD_SHA: sha });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, version, build: sha });
  });
});
