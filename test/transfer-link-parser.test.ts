import { describe, expect, it } from "vitest";
import { attributeUrl } from "./transfer-fixtures";

// Characterize the surprising HTMLRewriter/DOM boundary so future fixtures do
// not send `amp;grant`, or unescape the whole document before tokenization.
describe("transfer link fixture parses escaped HTML attributes", () => {
  it("decodes the query separator once without changing encoded path or parameter values", async () => {
    const html = '<a href="https://deliveries.example/parcel/report%26notes.txt?recipient=reader%26one&amp;grant=signed%2Bsample&amp;label=literal&amp;amp;value">Download</a>';
    let url: string | undefined;
    const rendered = await new HTMLRewriter().on("a[href]", {
      element(e) { url = attributeUrl(e.getAttribute("href")!, "https://dropway.test/transfer/parcel"); },
    }).transform(new Response(html)).text();
    expect(rendered).toBe(html);
    expect(url).toBe("https://deliveries.example/parcel/report%26notes.txt?recipient=reader%26one&grant=signed%2Bsample&label=literal&amp;value");
    expect(new URL(url!).searchParams.get("grant")).toBe("signed+sample");
    expect(new URL(url!).searchParams.has("amp;grant")).toBe(false);
  });
});
