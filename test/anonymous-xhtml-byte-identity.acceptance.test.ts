import { beforeEach, describe, expect, it } from "vitest";
import { freshInstance, type Instance } from "./helpers";

const NAV = {
  Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
};
const XHTML = '<?xml version="1.0" encoding="UTF-8"?>\r\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Anonymous café</title></head><body><p>Original bytes ✓ &amp; XML</p><img src="/mark.svg" alt="mark" /></body></html>\r\n';
const BYTES = new TextEncoder().encode(XHTML);
const HTML = '<!doctype html>\r\n<html><head><title>Anonymous café</title></head><body><p>HTML control ✓</p></body></html>\r\n';

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance({ sitesMode: "subdomain", sitesDomain: "sites.test", anonymous: { enabled: true } });
});

async function publish(content: string, contentType: string, path: string) {
  const result = await dw.json(`/api/v1/publish?path=${path}`, {
    method: "POST", key: null, headers: { "Content-Type": contentType }, body: content,
  });
  expect(result.status).toBe(201);
  expect(result.body.site.anonymous).toBe(true);
  expect(new URL(result.body.url).hostname).toBe(`${result.body.slug}.sites.test`);
  return result.body.url as string;
}

// Compute the stored-byte validator independently of the serving implementation.
async function originalEtag() {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", BYTES));
  return `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

async function reportAnchors(html: string) {
  const texts: string[] = [];
  let current = -1;
  await new HTMLRewriter().on("a", {
    element(element) {
      current = texts.push("") - 1;
      element.onEndTag(() => { current = -1; });
    },
    text(chunk) { if (current >= 0) texts[current] += chunk.text; },
  }).transform(new Response(html)).text();
  return texts.filter((text) => text.replace(/\s+/g, " ").trim() === "Report abuse");
}

// Subdomains have no path rewrite. Path-mode XHTML rewriting is intentionally out of scope.
describe("anonymous XHTML byte representation", () => {
  // Publishing normalizes text MIME types with a UTF-8 charset; pin that stored type.
  const contentType = "application/xhtml+xml; charset=utf-8";
  it("keeps navigation bytes and MIME type intact, without an HTML report anchor", async () => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    for (const path of ["", "index.xhtml"]) {
      const response = await dw.call(new URL(path, url).href, { headers: NAV });
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect.soft(response.status).toBe(200);
      expect.soft(response.headers.get("content-type")).toBe(contentType);
      expect.soft(bytes).toEqual(BYTES);
      expect.soft(await reportAnchors(new TextDecoder().decode(bytes))).toEqual([]);
    }
  });

  it("uses the original strong ETag and byte length for a full GET", async () => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    const response = await dw.call(url, { headers: NAV });
    await response.arrayBuffer();
    expect.soft(response.status).toBe(200);
    expect.soft(response.headers.get("etag")).toBe(await originalEtag());
    expect.soft(response.headers.get("content-length")).toBe(String(BYTES.length));
    expect.soft(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("serves HEAD with the original representation headers and no body", async () => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    const response = await dw.call(url, { method: "HEAD", headers: NAV });
    const body = await response.arrayBuffer();
    expect.soft(response.status).toBe(200);
    expect.soft(response.headers.get("content-type")).toBe(contentType);
    expect.soft(response.headers.get("etag")).toBe(await originalEtag());
    expect.soft(response.headers.get("content-length")).toBe(String(BYTES.length));
    expect.soft(response.headers.get("accept-ranges")).toBe("bytes");
    expect.soft(body.byteLength).toBe(0);
  });

  it("returns a bodyless 304 for the original strong validator", async () => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    const etag = await originalEtag();
    const response = await dw.call(url, { headers: { ...NAV, "If-None-Match": etag } });
    const body = await response.arrayBuffer();
    expect.soft(response.status).toBe(304);
    expect.soft(response.headers.get("etag")).toBe(etag);
    expect.soft(body.byteLength).toBe(0);
  });

  it("serves ranges of original bytes instead of injecting or ignoring Range", async () => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    const response = await dw.call(url, { headers: { ...NAV, Range: "bytes=40-99" } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect.soft(response.status).toBe(206);
    expect.soft(response.headers.get("content-type")).toBe(contentType);
    expect.soft(response.headers.get("etag")).toBe(await originalEtag());
    expect.soft(response.headers.get("content-range")).toBe(`bytes 40-99/${BYTES.length}`);
    expect.soft(response.headers.get("content-length")).toBe("60");
    expect.soft(bytes).toEqual(BYTES.slice(40, 100));
  });

  it.each(["raw=1", "download=1"])("preserves original bytes and strong validators for ?%s", async (query) => {
    const url = await publish(XHTML, contentType, "index.xhtml");
    const response = await dw.call(`${url}?${query}`, { headers: NAV });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes).toEqual(BYTES);
    expect(response.headers.get("etag")).toBe(await originalEtag());
    expect(response.headers.get("content-length")).toBe(String(BYTES.length));
    expect(await reportAnchors(new TextDecoder().decode(bytes))).toEqual([]);
    if (query === "raw=1") {
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-dropway-original-content-type")).toBe(contentType);
    } else {
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    }
  });
});

it("still injects one Report abuse anchor for anonymous text/html with charset", async () => {
  const url = await publish(HTML, "text/html; charset=utf-8", "index.html");
  const response = await dw.call(url, { headers: NAV });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(html).toContain("HTML control ✓");
  expect(html).not.toBe(HTML);
  expect(await reportAnchors(html)).toHaveLength(1);
});
