import { describe, expect, it } from "vitest";
import { instance, op, refusal, SITES } from "./transfer-fixtures";

describe("protected transfer fixture publish REST mapping", () => {
  it("publishes to the caller's requested slug instead of silently generating another", async () => {
    const dw = await instance();
    const args = { slug: "publish-mapping", files: [{ path: "notes.txt", content: "mapped bytes" }] };
    const published = await op(dw, "publish_site", args);
    expect(published.status).toBe(200);
    expect(published.body.slug).toBe("publish-mapping");
    expect(args).toEqual({ slug: "publish-mapping", files: [{ path: "notes.txt", content: "mapped bytes" }] });
    expect(await (await dw.call(`${SITES}/publish-mapping/notes.txt`)).text()).toBe("mapped bytes");
  });
});

describe("protected transfer fixture delete REST mapping", () => {
  it("deletes the named site without mutating the caller's arguments", async () => {
    const dw = await instance();
    expect((await op(dw, "create_site", { slug: "delete-mapping" })).status).toBe(201);
    const args = { site: "delete-mapping", confirm: "delete-mapping" };
    const deleted = await op(dw, "delete_site", args);
    expect(deleted.status).toBe(200);
    expect(args).toEqual({ site: "delete-mapping", confirm: "delete-mapping" });
    expect((await dw.json("/api/v1/sites/delete-mapping", { key: dw.ownerKey })).status).toBe(404);
  });

  it("preserves the native REST slug argument and the missing-site refusal", async () => {
    const dw = await instance();
    expect((await op(dw, "create_site", { slug: "native-delete-mapping" })).status).toBe(201);
    expect((await op(dw, "delete_site", { slug: "native-delete-mapping" })).status).toBe(200);
    refusal(await op(dw, "delete_site", { site: "missing-delete-mapping", confirm: "missing-delete-mapping" }), 404);
  });
});
