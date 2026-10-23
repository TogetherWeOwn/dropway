import { browserSignin } from "./auth-client";
import type { Context, Hono } from "hono";
import { ApiError, browserWriteAllowed, claimSite, consumeLoginLink, getMember, inspectLoginLink, listSessions, requireBrowserWrite, resolveSession, sessionSetCookie, sessionToken } from "@dropway/core";
import type { DropwayEnv } from "../env";
import { escapeHtml, htmlPage } from "../html";

const SCRIPT_PATH = "/__dropway/auth.js";
const headers = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
};

function page(c: Context<DropwayEnv>, title: string, body: string) {
  return c.html(htmlPage({ title, head: `<script src="${SCRIPT_PATH}" defer></script>`, body: `<main class="dw-system"><p><a href="/">Home</a> · <a href="/dashboard/sessions">My sessions</a></p><h1>${escapeHtml(title)}</h1>${body}<p id="dw-auth-status" role="status" aria-live="polite"></p></main>` }), 200, headers);
}

export async function loginConfirmationPage(c: Context<DropwayEnv>, token: string) {
  const { member } = await inspectLoginLink(c.get("dw"), token, c.req.raw);
  return page(c, "Confirm sign-in", `<div id="dw-login-confirm"><p>This link signs you in as <strong>${escapeHtml(member.email ?? member.name ?? member.id)}</strong>. Only continue if this is your account.</p><form method="post" action="/login/confirm"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Sign in as this member</button></form><p><a href="/login">Cancel</a></p></div>`);
}

export async function claimPage(c: Context<DropwayEnv>) {
  const slug = c.req.query("slug") ?? "";
  const p = await resolveSession(c.get("dw"), c.req.raw).catch(() => null);
  const target = `/claim?slug=${encodeURIComponent(slug)}`;
  const form = p
    ? `<p>Signed in as ${escapeHtml((await getMember(c.get("dw"), p.memberId)).email ?? "member")}. Keep <code>${escapeHtml(slug)}</code> in your account.</p><form method="post" action="/claim" id="dw-claim"><input type="hidden" name="slug" value="${escapeHtml(slug)}"><label>Claim token <input name="claimToken" type="password" autocomplete="off" required></label><button type="submit">Claim this site</button></form>`
    : `<p>Sign in as an existing member to keep <code>${escapeHtml(slug)}</code>. Its claim token stays in this tab until you submit the claim.</p><a href="/login?next=${encodeURIComponent(target)}" id="dw-claim-signin">Sign in to claim</a><p>With an API key, use POST /api/v1/sites/${escapeHtml(slug)}/claim and the claim token.</p>`;
  return page(c, "Keep this site", `<div id="dw-claim-page" data-slug="${escapeHtml(slug)}">${form}</div>`);
}

/** Thin app operation: member authority plus proof still enforced by claimSite. */
export async function claimSubmission(c: Context<DropwayEnv>) {
  try {
    const dw = c.get("dw");
    const p = await resolveSession(dw, c.req.raw);
    const input = new URLSearchParams(await c.req.text());
    const site = await claimSite(dw, p, input.get("slug") ?? "", input.get("claimToken"));
    return c.redirect(`/dashboard/sessions?claimed=${encodeURIComponent(site.slug)}`, 303);
  } catch (err) {
    if (err instanceof ApiError) return c.text(`${err.message} ${err.hint ?? ""}`, err.status as 400, headers);
    throw err;
  }
}

export function installSigninUi(app: Hono<DropwayEnv>) {
  app.post("/login/confirm", async (c) => {
    try {
      requireBrowserWrite(c.get("dw"), c.req.raw);
      const body = new URLSearchParams(await c.req.text());
      const session = await consumeLoginLink(c.get("dw"), body.get("token"), c.req.raw);
      c.header("Set-Cookie", session.cookie);
      return c.redirect("/dashboard/sessions", 303);
    } catch (err) {
      if (err instanceof ApiError) return c.text(`${err.message} ${err.hint ?? ""}`, err.status as 400, headers);
      throw err;
    }
  });
  app.get(SCRIPT_PATH, (c) => c.body(`(${browserSignin.toString()})();`, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }));
  app.get("/dashboard/sessions", async (c) => {
    const dw = c.get("dw");
    let principal;
    try { principal = await resolveSession(dw, c.req.raw); }
    catch { return c.redirect("/login", 303); }
    const member = await getMember(dw, principal.memberId);
    const result = await listSessions(dw, principal);
    const rows = result.sessions.map((session) => `<li>${escapeHtml(String(session.via))} · ${escapeHtml(new Date(Number(session.createdAt)).toISOString())} <button type="button" data-revoke="${escapeHtml(String(session.id))}">Revoke session</button></li>`).join("");
    if (browserWriteAllowed(dw, c.req.raw)) c.header("Set-Cookie", sessionSetCookie(sessionToken(c.req.raw)!));
    return page(c, "Your sessions", `<p>Signed in as ${escapeHtml(member.email ?? "member")}.</p><p>Browser sessions can claim anonymous sites. The API-key dashboard and agents use bearer credentials, never this cookie.</p><ul>${rows}</ul><form method="post" action="/api/v1/auth/logout"><button type="submit">Sign out</button></form><p><a href="/login">API-key dashboard</a></p>`);
  });
}

