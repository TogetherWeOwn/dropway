import {
  ApiError, appOrigin, checkTransferGate, describeTransfer, makeTransferGrant, openTransferDownload,
  publicTransfer, transferCookieName, transferFileUrl, transferMissing, transferPageUrl, transferRecipients,
  transferUnlocked, unlockTransfer, type DropwayContext, type PublicTransfer,
} from "@dropway/core";
import type { Hono } from "hono";
import type { DropwayEnv } from "./env";
import { APP_PAGE_CSP, escapeHtml, siteSystemCsp, systemPage } from "./html";
import { appStatePage } from "./ui/shell";
import { themeFromQuery } from "./ui/theme";

const headers = {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY",
};
/** A delivery page in the app's Security Print chrome (header, mode switch, footer). `message` is escaped here; `extra` is trusted HTML. */
function page(dc: DropwayContext, url: string, message: string, extra = "", status = 200) {
  const html = appStatePage(dc, url, { title: "File delivery", code: "FILE DELIVERY", heading: "File delivery", message: escapeHtml(message), extra });
  return new Response(html, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", Vary: "Cookie" } });
}
function passwordPage(dc: DropwayContext, url: string, t: PublicTransfer, recipient?: string) {
  return page(dc, url, "This delivery is password protected.", `<form method="post" action="${escapeHtml(transferPageUrl(dc, t.slug, recipient))}"><label class="k-label" for="dw-tpw">Password</label><div class="k-field"><input class="k-input" id="dw-tpw" type="password" name="password" minlength="8" maxlength="1024" required autocomplete="current-password"><button class="k-btn" type="submit">Unlock delivery</button></div></form>`, 403);
}
/**
 * A locked file asked for on the sites origin: a site page (site CSS inline, fonts from the app origin,
 * siteSystemCsp, no mode switch: the app's cookie and theme route do not exist here) that sends the
 * recipient to the delivery's page in the app to unlock it.
 */
function lockedFilePage(dc: DropwayContext, request: Request, slug: string) {
  const html = systemPage({
    code: "FILE DELIVERY",
    title: "This delivery is password protected",
    message: "Unlock it on its page, then open this file again.",
    extra: `<div class="k-acts"><a class="k-btn" href="${escapeHtml(transferPageUrl(dc, slug))}">Unlock this delivery</a></div>`,
    dw: dc,
    theme: themeFromQuery(request.url) ?? "auto",
    trust: true,
  });
  return new Response(html, {
    status: 403,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `${siteSystemCsp(dc)}; frame-ancestors 'none'` },
  });
}
/** "2026-10-30 09:00 UTC": dates always name their zone. */
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
export function transferError(error: unknown): Response {
  if (!(error instanceof ApiError)) throw error;
  return Response.json(error.toJSON(), { status: error.status, headers: { ...headers, ...(error.status === 429 ? { "Retry-After": String(error.details?.retryAfterSeconds ?? 60) } : {}) } });
}
async function readPasswordForm(request: Request): Promise<string> {
  const maxBytes = 16_384;
  const tooLarge = () => new ApiError(413, "request_too_large", "Form too large.", "Send a password form of at most 16,384 bytes.");
  if (Number(request.headers.get("Content-Length")) > maxBytes) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      buffer.set(value, bytes);
      bytes += value.byteLength;
    }
    return new TextDecoder().decode(buffer.subarray(0, bytes));
  } finally { reader.releaseLock(); }
}
export function installTransferPages(app: Hono<DropwayEnv>) {
  app.on(["GET", "HEAD", "POST"], "/t/:slug", async (c) => {
    const dc = c.get("dw");
    try {
      if (new URL(c.req.url).origin !== new URL(appOrigin(dc)).origin) throw transferMissing();
      const t = await publicTransfer(dc, c.req.param("slug"));
      checkTransferGate(t);
      const recipient = c.req.query("recipient");
      if (recipient && !transferRecipients(t).some((r) => r.token === recipient)) throw transferMissing();
      if (c.req.method === "POST") {
        if (c.req.header("Origin") !== appOrigin(dc) || ["cross-site", "same-site"].includes(c.req.header("Sec-Fetch-Site") ?? "")) return new Response("Origin refused", { status: 403, headers });
        const text = await readPasswordForm(c.req.raw);
        const grant = await unlockTransfer(dc, t, new URLSearchParams(text).get("password"), c.req.header("CF-Connecting-IP") ?? "unknown");
        return new Response(null, { status: 303, headers: { ...headers, Location: transferPageUrl(dc, t.slug, recipient),
          "Set-Cookie": `${transferCookieName(t)}=${grant}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900` } });
      }
      if (!await transferUnlocked(dc, t, c.req.raw)) return passwordPage(dc, c.req.url, t, recipient);
      const description = await describeTransfer(dc, t);
      const grant = t.password_hash ? await makeTransferGrant(dc, t) : null;
      const files = description.files.map((f) => {
        const url = new URL(transferFileUrl(dc, t.slug, f.path, recipient));
        if (grant) url.searchParams.set("grant", grant);
        return `<li><a href="${escapeHtml(url.href)}" rel="noreferrer">${escapeHtml(f.path)}</a> — ${f.size} bytes, ${escapeHtml(f.contentType)}<br><code class="k-mono k-small">SHA-256 ${f.sha256}</code></li>`;
      }).join("");
      const note = t.message ? `<p style="white-space:pre-wrap">${escapeHtml(t.message)}</p>` : "";
      const response = page(dc, c.req.url, `Available until ${utc(new Date(t.expires_at).getTime())}.`, `${note}<ul>${files}</ul><p class="k-trust">Kofra does not scan files; open files only from people you trust.</p>`);
      return c.req.method === "HEAD" ? new Response(null, response) : response;
    } catch (error) { return transferError(error); }
  });
}

export async function serveTransfer(request: Request, dc: DropwayContext, slug: string, path: string): Promise<Response> {
  try {
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    const out = await openTransferDownload(dc, request, slug, path);
    if (out.locked) {
      if ((request.headers.get("Accept") ?? "").includes("text/html")) return lockedFilePage(dc, request, slug);
      throw new ApiError(403, "transfer_locked", "Password required.", "Unlock the delivery on its app-origin page.");
    }
    const filename = out.file.path.split("/").pop()!;
    const disposition = `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`)}`;
    return new Response(out.body, { status: out.ranged ? 206 : 200, headers: {
      ...headers, "Content-Type": out.file.content_type, "Content-Disposition": disposition,
      "Content-Length": String(out.length), "Accept-Ranges": "bytes",
      ...(out.ranged ? { "Content-Range": `bytes ${out.offset}-${out.offset + out.length - 1}/${out.file.size}` } : {}),
    } });
  } catch (error) { return transferError(error); }
}
