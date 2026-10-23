import type { Context } from "hono";
import { cloneRawRequest } from "hono/request";
import { ApiError } from "@dropway/core";
import type { DropwayEnv } from "../env";

/** Browser auth forms have a wire-byte bound, independent of the JSON budget. */
export async function readForm(c: Context<DropwayEnv>): Promise<URLSearchParams> {
  const maxBytes = 65_536;
  const tooLarge = () => new ApiError(413, "request_too_large", `Sign-in and claim forms accept up to ${maxBytes} bytes.`, "Remove extra form fields and submit again.", { limit: maxBytes });
  if (Number(c.req.header("Content-Length")) > maxBytes) {
    if (!c.req.raw.body?.locked) await c.req.raw.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const cached = Object.keys(c.req.bodyCache).length > 0;
  // Match readJson's cached-body compatibility without teeing an unread stream.
  const body = cached ? (await cloneRawRequest(c.req)).body : c.req.raw.body;
  let text = "";
  if (body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  if (!cached) Object.assign(c.req.bodyCache, { text: Promise.resolve(text) });
  return new URLSearchParams(text);
}
