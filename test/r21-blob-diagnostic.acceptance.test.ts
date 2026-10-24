import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callWithBindings, digest, env, freshInstance, issuedSessionCookies, jsonBody, loginLink,
  ORIGIN, sessionCookie,
} from "./r21-helpers";
import { rowsSnapshot } from "./r21-remaining-contract.helpers";

afterEach(() => vi.restoreAllMocks());
const CONTENT = "bounded real published range diagnostic";

async function publishedFixture() {
  const dw = await freshInstance({ appOrigin: ORIGIN });
  const published = await dw.json("/api/v1/publish", {
    key: dw.ownerKey, ...jsonBody({ files: [{ path: "diagnostic.txt", content: CONTENT }] }),
  });
  expect(published.status).toBe(201);
  const path = `/s/${published.body.slug}/diagnostic.txt`;
  const key = `blobs/${await digest(CONTENT)}`;
  expect(Boolean(await env.FILES.head(key)), "the real publisher must have persisted the actual blob").toBe(true);
  const link = await loginLink(dw);
  const url = new URL(path, ORIGIN);
  url.searchParams.set("token", link.token);
  url.searchParams.set("unrecognized_query_field", "local-unrecognized-query-marker");
  return { dw, path, key, link, url };
}

// Break caught: the inner missing-blob branch logs raw request.url even though
// outer router errors are sanitized. Arbitrary site URLs can carry valid proof.
// Fault only this local R2 get; the issuer, publication, router and logger are real.
// Boolean secrecy assertions intentionally never print the raw query or proof.
describe("R-21 real missing-blob diagnostic query boundary", () => {
  it("keeps a useful blob_missing event and safe path without logging any query or live login proof", async () => {
    const f = await publishedFixture();
    const before = await rowsSnapshot();
    let missingGets = 0;
    const files = new Proxy(env.FILES, { get(target, property) {
      if (property === "get") return (...args: unknown[]) => {
        if (args[0] === f.key) { missingGets++; return Promise.resolve(null); }
        return Reflect.apply(target.get, target, args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const logs: unknown[][] = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args); });
    }
    // Range forces a bounded R2 read, rather than a pre-existing edge cache hit.
    const response = await callWithBindings(f.dw, f.url.href, { FILES: files }, { headers: { Range: "bytes=0-6" } });
    const diagnostic = logs.flat().map((value) => value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ""}` :
      typeof value === "string" ? value : JSON.stringify(value)).join("\n");
    vi.restoreAllMocks();
    expect(response.status).toBe(502);
    expect(missingGets, "fault only one local read, not the router or auth service").toBe(1);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await rowsSnapshot()) === before, "a site read must not consume login proof or mutate other D1 rows").toBe(true);
    expect(diagnostic.includes("blob_missing"), "do not fix redaction by dropping the diagnostic").toBe(true);
    expect(diagnostic.includes(f.path), "retain a useful safe site path for debugging").toBe(true);
    expect.soft(diagnostic.includes(f.link.token), "the still-redeemable issuer token must not enter logs").toBe(false);
    expect.soft(diagnostic.includes("local-unrecognized-query-marker"), "unknown query values must be stripped too").toBe(false);
    expect.soft(diagnostic.includes("unrecognized_query_field"), "remove the whole query, not only recognized credential parameters").toBe(false);
    expect.soft(diagnostic.includes(f.url.search), "never log the raw URL query").toBe(false);
    // Prove this was live authority, not an invented, expired or already-used token.
    const redeemed = await f.dw.call(f.link.url, { headers: { Accept: "application/json" } });
    const cookie = sessionCookie(redeemed);
    expect((await f.dw.call("/api/v1/auth/sessions", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(issuedSessionCookies(await f.dw.call(f.link.url))).toEqual([]);
  });

  it("positive control: the healthy real site serves its range and the original link still redeems", async () => {
    const f = await publishedFixture();
    const before = await rowsSnapshot();
    const response = await f.dw.call(f.url.href, { headers: { Range: "bytes=0-6" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-6/${CONTENT.length}`);
    expect(await response.text()).toBe("bounded");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await rowsSnapshot()) === before).toBe(true);
    sessionCookie(await f.dw.call(f.link.url, { headers: { Accept: "application/json" } }));
  });
});
