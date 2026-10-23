// The product's former name (Dropway) keeps working for clients built before the rename.
// rebrand:keep-file (scripts/rebrand.mjs never edits this file.)
import { beforeEach, describe, expect, it } from "vitest";
import { form, freshInstance, type Instance } from "./helpers";

let dw: Instance;
beforeEach(async () => {
  dw = await freshInstance();
});

describe("former name compatibility", () => {
  it("sends every X-Kofra-* response header as X-Dropway-* too", async () => {
    const pub = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, body: form({ "index.html": "<p>hi</p>", "notes.md": "# Notes" }) });
    expect(pub.status).toBe(201);
    const page = await dw.call(`/s/${pub.body.slug}/`);
    expect(page.headers.get("x-kofra-site")).toBe(pub.body.slug);
    expect(page.headers.get("x-dropway-site")).toBe(pub.body.slug);
    expect(page.headers.get("x-kofra-version")).toBeTruthy();
    expect(page.headers.get("x-dropway-version")).toBe(page.headers.get("x-kofra-version"));
    const viewer = await dw.call(`/s/${pub.body.slug}/notes.md`, { headers: { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" } });
    expect(viewer.headers.get("x-kofra-viewer")).toBe("markdown");
    expect(viewer.headers.get("x-dropway-viewer")).toBe("markdown");
  });

  it("reads X-Dropway-* request headers, and X-Kofra-* wins when both are sent", async () => {
    const legacy = await dw.json("/api/v1/publish", { method: "POST", key: dw.ownerKey, headers: { "Content-Type": "text/markdown", "X-Dropway-Path": "old.md" }, body: "# Old" });
    expect(legacy.status).toBe(201);
    expect(legacy.body.files).toEqual(["old.md"]);
    const both = await dw.json("/api/v1/publish", {
      method: "POST",
      key: dw.ownerKey,
      headers: { "Content-Type": "text/markdown", "X-Dropway-Path": "old.md", "X-Kofra-Path": "new.md" },
      body: "# New",
    });
    expect(both.body.files).toEqual(["new.md"]);
  });

  it("allows and exposes both header spellings to browsers (CORS)", async () => {
    const res = await dw.call("/api/v1/publish", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-dropway-path" },
    });
    expect(res.status).toBeLessThan(300);
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowed).toContain("X-Kofra-Path");
    expect(allowed).toContain("X-Dropway-Path");
    const mcp = await dw.call("/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274", "Access-Control-Request-Method": "POST" } });
    expect(mcp.headers.get("access-control-allow-headers")).toContain("X-Dropway-Toolsets");
  });

  it("serves the Agent Skill under its former name", async () => {
    for (const path of ["/.well-known/agent-skills/dropway/SKILL.md", "/.well-known/skills/dropway/SKILL.md"]) {
      const res = await dw.call(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^name: kofra$/m);
    }
  });
});
