import vm from "node:vm";
import { createTestHarness } from "wrangler";
import { expect } from "vitest";
import { consumeLoginLink } from "@dropway/core";
import { Context } from "hono";
import { createDropway } from "../src/create.ts";
import { loginConfirmationPage } from "../src/ui/signin.ts";
import type { DropwayEnv, ServerBindings } from "../src/env.ts";

export const ORIGIN = "https://dropway.test";
// Node's native fetch Request has credentials; the shared Workers typings omit it.
export type BrowserRequest = Request & { readonly credentials: string };

// Real local Worker, migrations, issuer and server-rendered forms. No remote
// resources, cookie fabrication, auth-service mocks or security-header injection.
export async function authInstance() {
  const root = new URL("../../../", import.meta.url);
  const worker = createTestHarness({ root: root.pathname, workers: [{ config: {
    name: "auth-submit-acceptance", main: new URL("apps/worker/src/index.ts", root).pathname,
    compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], keep_names: false,
    vars: { APP_ORIGIN: ORIGIN, ADMIN_BOOTSTRAP_KEY: "test-bootstrap-secret-0123456789" },
    d1_databases: [{ binding: "DB", database_name: "auth-submit-local", migrations_dir: new URL("packages/core/migrations", root).pathname }],
    r2_buckets: [{ binding: "FILES", bucket_name: "auth-submit-local" }],
    kv_namespaces: [{ binding: "CACHE", id: "auth-submit-local" }],
  } }] });
  try {
    await worker.listen();
    const binding = worker.getWorker<ServerBindings>();
    await binding.applyD1Migrations("DB");
    const call = (path: string, init: Parameters<typeof binding.fetch>[1] = {}) => binding.fetch(new URL(path, ORIGIN).href, { ...init, redirect: "manual" });
    const setup = await call("/api/v1/setup", {
      method: "POST", headers: { Authorization: "Bearer test-bootstrap-secret-0123456789", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Submit acceptance", email: "member@example.com" }),
    });
    expect(setup.status).toBe(201);
    const owner = await setup.json() as { apiKey: { key: string }; member: { id: string } };
    return {
      dispose: () => worker.close(),
      async page(kind: "login" | "logout" | "claim") {
        const issued = await call("/api/v1/login-links", {
          method: "POST", headers: { Authorization: `Bearer ${owner.apiKey.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ memberId: owner.member.id }),
        });
        expect(issued.status).toBe(201);
        const link = await issued.json() as { url: string };
        const token = new URL(link.url).searchParams.get("token")!;
        const tasks: Promise<unknown>[] = [];
        const dc = createDropway().context(await binding.getEnv(), { waitUntil(task) { tasks.push(task); } });
        let response;
        if (kind === "login") {
          // Render the real confirmation function directly: Node transports
          // differ in Fetch Metadata, and these tests must not forge it.
          const c = new Context<DropwayEnv>(new Request(link.url));
          c.set("dw", dc);
          response = await loginConfirmationPage(c, token);
          expect(response.headers.getSetCookie()).toEqual([]);
        } else {
          // Actual core issuer, same emulated D1; never invent a session cookie
          // or spoof Origin/Fetch Metadata to reach a protected browser POST.
          const session = await consumeLoginLink(dc, token, new Request(link.url));
          expect(session.cookie).toMatch(/^__Host-dw_session=.+;.*HttpOnly/i);
          response = await call(kind === "claim" ? "/claim?slug=submit-control" : "/dashboard/sessions", { headers: { Cookie: session.cookie.split(";", 1)[0]! } });
        }
        await Promise.all(tasks);
        expect(response.status).toBe(200);
        expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(response.headers.get("Cache-Control")).toContain("no-store");
        const html = await response.text();
        expect(html).toMatch(/<script\b[^>]*src="\/__dropway\/auth\.js"[^>]*defer/);
        const script = await call("/__dropway/auth.js");
        expect(script.status).toBe(200);
        return { html, token, script: await script.text(), path: kind === "login" ? "/login" : kind === "claim" ? "/claim" : "/dashboard/sessions" };
      },
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

// Like path-shim.test.ts, this is a Node/vm browser-code harness, NOT a browser.
// Parse the genuine page's elements/attributes, with only the DOM subset needed
// by the first-party script. FormData serializes those actual form controls.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  disabled = false;
  textContent = "";
  listeners = new Map<string, Array<(event: Event) => unknown>>();
  constructor(public tagName: string, public attrs: Record<string, string>) {}
  get id() { return this.attrs.id || ""; }
  get value() { return this.attrs.value || ""; }
  set value(value: string) { this.attrs.value = value; }
  get action() { return new URL(this.attrs.action || "", ORIGIN).href; }
  get method() { return this.attrs.method || "get"; }
  get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5), value])); }
  get elements() { return this.querySelectorAll("input,button"); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(type: string, callback: (event: Event) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  matches(selector: string): boolean {
    const match = selector.match(/^(\w+)?(?:#([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/);
    if (!match) throw new Error(`DOM harness does not support selector: ${selector}`);
    return (!match[1] || this.tagName === match[1].toLowerCase()) && (!match[2] || this.id === match[2])
      && (!match[3] || (match[4] === undefined ? match[3] in this.attrs : this.attrs[match[3]] === match[4]));
  }
  querySelectorAll(selector: string): Element[] {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return all;
    return all.filter((node) => selector.split(",").some((choice) => {
      const parts = choice.trim().split(/\s+/);
      if (!node.matches(parts.pop()!)) return false;
      let parent = node.parent;
      while (parts.length && parent) {
        if (parent.matches(parts[parts.length - 1]!)) parts.pop();
        parent = parent.parent;
      }
      return parts.length === 0;
    }));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}

export function browser(page: { html: string; path: string; script: string }, respond: (request: BrowserRequest) => Promise<Response>) {
  const document = new Element("document", {}) as Element & { getElementById(id: string): Element | null };
  let parent = document as Element;
  for (const match of page.html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)) {
    const tag = match[2]!.toLowerCase();
    if (match[1]) {
      while (parent !== document && parent.tagName !== tag) parent = parent.parent!;
      if (parent !== document) parent = parent.parent!;
    } else {
      const attrs = Object.fromEntries([...match[3]!.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)].map((attr) => [attr[1]!, attr[2] ?? attr[3] ?? attr[4] ?? ""]));
      const element = new Element(tag, attrs);
      element.parent = parent;
      parent.children.push(element);
      if (!["input", "meta", "link", "br", "hr", "img"].includes(tag)) parent = element;
    }
  }
  document.getElementById = (id) => document.querySelector(`#${id}`);
  Object.defineProperty(document, "cookie", { get() { throw new Error("HttpOnly session proof must not be read by JavaScript"); } });
  const requests: BrowserRequest[] = [];
  const navigations: string[] = [];
  const pending = JSON.stringify({ slug: "keep-unclaimed", token: "claim-fixture-only" });
  const storage = new Map<string, string>();
  const location = {
    origin: ORIGIN, pathname: page.path, search: "", hash: "",
    assign: (url: string) => { navigations.push(url); },
    replace: (url: string) => { navigations.push(url); },
    reload: () => { navigations.push("reload"); },
    get href() { return new URL(page.path, ORIGIN).href; },
    set href(url: string) { navigations.push(url); },
  };
  const context = {
    document, location, URL, URLSearchParams, Headers, Request, Response,
    FormData: class {
      constructor(private form: Element) {}
      *[Symbol.iterator]() {
        for (const field of this.form.querySelectorAll("input")) {
          if (field.attrs.name && !field.disabled) yield [field.attrs.name, field.value];
        }
      }
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    fetch: (input: string | Request, init?: RequestInit) => {
      const request = new Request(typeof input === "string" ? new URL(input, ORIGIN) : input, init) as BrowserRequest;
      requests.push(request);
      if (new URL(request.url).pathname === "/api/v1/auth/sessions/refresh") return Promise.resolve(new Response("{}"));
      return respond(request);
    },
  };
  vm.runInNewContext(page.script, { ...context, window: context });
  // Add a pending claim after boot: existing sessions-page claim resumption is
  // outside this slice; submit/refusal must not spend or auto-submit that claim.
  storage.set("dw_pending_claim", pending);
  return {
    document, requests, navigations, storage, pending,
    async submit(form: Element) {
      const event = new Event("submit", { cancelable: true, bubbles: true });
      Object.defineProperties(event, { target: { value: form }, submitter: { value: form.querySelector("button") } });
      for (let node: Element | null = form; node; node = node.parent) {
        Object.defineProperty(event, "currentTarget", { value: node, configurable: true });
        for (const callback of node.listeners.get("submit") || []) await callback(event);
      }
      return event;
    },
  };
}

export function followed(path: string) {
  const response = new Response("<p>Destination</p>", { status: 200, headers: { "Content-Type": "text/html" } });
  Object.defineProperties(response, { url: { value: new URL(path, ORIGIN).href }, redirected: { value: true } });
  return response;
}
