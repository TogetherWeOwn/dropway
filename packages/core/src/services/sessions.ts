import { appOrigin, type DropwayContext } from "../context";
import { badRequest, forbidden, notFound, unauthorized } from "../errors";
import { hmacHex, newId, newSecret, sha256Hex } from "../lib/crypto";
import { ROLE_SCOPES, requireMember, type MemberPrincipal, type Principal } from "../principal";
import type { MemberRow } from "./tenants";

export const SESSION_COOKIE = "__Host-dw_session";
export const SESSION_TTL = 30 * 24 * 3600_000;
export const SIGN_IN_TTL = 15 * 60_000;

export function browserWriteAllowed(dc: DropwayContext, request: Request): boolean {
  return request.headers.get("Origin") === appOrigin(dc) && request.headers.get("Sec-Fetch-Site") === "same-origin" && new URL(request.url).origin === appOrigin(dc);
}

/** Both checks are mandatory, including on same-site workers.dev siblings. */
export function requireBrowserWrite(dc: DropwayContext, request: Request): void {
  if (!browserWriteAllowed(dc, request)) {
    throw forbidden("This browser operation requires the exact app origin and same-origin Fetch Metadata.", "Open the app directly and try again.", "cross_origin_request");
  }
}

export function sessionToken(request: Request): string | null {
  const values = (request.headers.get("Cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(SESSION_COOKIE.length + 1);
  return /^dws_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function sessionSetCookie(token: string, clear = false): string {
  return `${SESSION_COOKIE}=${clear ? "" : token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL / 1000}`;
}

/** Join every time: removing/disabling a member or tenant immediately removes authority. */
export async function activeMember(dc: DropwayContext, memberId: string): Promise<MemberRow | null> {
  return dc.env.DB.prepare("SELECT m.* FROM members m JOIN tenants t ON t.id = m.tenant_id WHERE m.id = ? AND m.disabled_at IS NULL AND t.disabled_at IS NULL")
    .bind(memberId).first<MemberRow>();
}

export function memberPrincipal(member: MemberRow, ip: string, via: string): MemberPrincipal {
  return { kind: "member", tenantId: member.tenant_id, memberId: member.id, role: member.role, scopes: ROLE_SCOPES[member.role], keyId: null, siteId: null, via, ip };
}

export async function createLoginLink(dc: DropwayContext, p: Principal, input: { memberId?: unknown } = {}) {
  const caller = requireMember(p);
  // Minting a browser session must not widen a constrained API credential.
  if (caller.siteId || ROLE_SCOPES[caller.role].some((scope) => !caller.scopes.includes(scope))) {
    throw forbidden("A restricted key cannot mint a member session.", "Use an unrestricted key with all scopes for your role.", "restricted_login_key");
  }
  const memberId = input.memberId === undefined ? caller.memberId : String(input.memberId);
  if (memberId !== caller.memberId && (!caller.scopes.includes("members:write") || caller.role === "member")) throw forbidden("You may only create your own login link.");
  const member = await activeMember(dc, memberId);
  if (!member || member.tenant_id !== caller.tenantId) throw notFound("member_not_found", "Member not found.");
  if (member.id !== caller.memberId && (ROLE_SCOPES[member.role].some((s) => !caller.scopes.includes(s)) || (member.role === "owner" && caller.role !== "owner"))) throw forbidden("You cannot mint a session with greater member authority.");
  const token = newSecret("dwl_");
  const now = Date.now();
  const expiresAt = now + SIGN_IN_TTL;
  await dc.env.DB.prepare("INSERT INTO login_links (token_hash, member_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), member.id, caller.memberId, now, expiresAt).run();
  return { url: `${appOrigin(dc)}/login?token=${token}`, expiresAt };
}

export function requireSessionOrigin(dc: DropwayContext, request: Request): void {
  if (new URL(request.url).protocol !== "https:" || new URL(request.url).origin !== appOrigin(dc)) throw forbidden("Sessions require the HTTPS app origin.", "Use the configured HTTPS app URL.", "insecure_session_origin");
}

export async function issueSession(dc: DropwayContext, member: MemberRow, request: Request, via: string) {
  requireSessionOrigin(dc, request);
  const token = newSecret("dws_");
  const now = Date.now();
  await dc.env.DB.prepare("INSERT INTO sessions (id_hash, id, tenant_id, member_id, via, created_at, expires_at, last_seen_at, ip_hash, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), newId("ses"), member.tenant_id, member.id, via, now, now + SESSION_TTL, now,
      await hmacHex(dc.config.signingSecret, request.headers.get("cf-connecting-ip") ?? "0.0.0.0"), (request.headers.get("user-agent") ?? "").slice(0, 512)).run();
  return { cookie: sessionSetCookie(token) };
}

/** Explicit browser surfaces only; ordinary REST and MCP never resolve cookies. */
async function sessionState(dc: DropwayContext, request: Request, readOnly = false) {
  if (!["GET", "HEAD"].includes(request.method)) requireBrowserWrite(dc, request);
  const token = sessionToken(request);
  if (!token || new URL(request.url).origin !== appOrigin(dc) || new URL(request.url).protocol !== "https:") throw unauthorized("Sign in to continue.", "Open /login.", "invalid_session");
  const now = Date.now();
  const row = await dc.env.DB.prepare("SELECT s.id, s.member_id, s.last_seen_at FROM sessions s JOIN members m ON m.id = s.member_id AND m.tenant_id = s.tenant_id JOIN tenants t ON t.id = s.tenant_id WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND m.disabled_at IS NULL AND t.disabled_at IS NULL")
    .bind(await sha256Hex(token), now).first<{ id: string; member_id: string; last_seen_at: number }>();
  if (!row) throw unauthorized("This session expired or was revoked.", "Sign in again at /login.", "invalid_session");
  const member = await activeMember(dc, row.member_id);
  if (!member) throw unauthorized();
  // Ordinary navigation omits Origin. It may read, but must not slide authority.
  const refreshed = !readOnly && browserWriteAllowed(dc, request) && now - row.last_seen_at >= 3600_000;
  if (refreshed) {
    const changed = await dc.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? RETURNING id")
      .bind(now, now + SESSION_TTL, row.id, now).first();
    if (!changed) throw unauthorized("This session expired or was revoked.", "Sign in again at /login.", "invalid_session");
  }
  return { principal: memberPrincipal(member, request.headers.get("cf-connecting-ip") ?? "0.0.0.0", "session"), refreshed };
}

export async function resolveSession(dc: DropwayContext, request: Request): Promise<MemberPrincipal> {
  return (await sessionState(dc, request)).principal;
}

/** A first-party POST naturally carries Origin; cookie and D1 renew together. */
export async function refreshSession(dc: DropwayContext, request: Request) {
  requireBrowserWrite(dc, request);
  const state = await sessionState(dc, request);
  return { ...(state.refreshed ? { cookie: sessionSetCookie(sessionToken(request)!) } : {}) };
}

/** Inspect without consuming: browser confirmation must not spend the credential. */
export async function inspectLoginLink(dc: DropwayContext, token: unknown, request: Request) {
  requireSessionOrigin(dc, request);
  if (typeof token !== "string" || !/^dwl_[A-Za-z0-9_-]{43}$/.test(token)) throw badRequest("invalid_login_link", "This login link is invalid or expired.", "Request a new login link.");
  const hash = await sha256Hex(token);
  const link = await dc.env.DB.prepare("SELECT member_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(hash, Date.now()).first<{ member_id: string }>();
  const member = link && await activeMember(dc, link.member_id);
  if (!member) throw unauthorized("This login link is invalid or expired.", "Request a new login link.", "invalid_login_link");
  // Do not silently swap a different signed-in account when following a link.
  if (sessionToken(request)) {
    const current = await sessionState(dc, request, true).then((state) => state.principal).catch(() => null);
    if (current && current.memberId !== member.id) throw forbidden("Sign out before using a link for a different member.", "Sign out deliberately, then reopen the link.", "session_account_mismatch");
  }
  return { member, hash };
}

export async function consumeLoginLink(dc: DropwayContext, token: unknown, request: Request) {
  const { member, hash } = await inspectLoginLink(dc, token, request);
  const now = Date.now();
  const consumed = await dc.env.DB.prepare("UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING member_id")
    .bind(now, hash, now).first();
  if (!consumed) throw unauthorized("This login link was used or expired.", "Request a new login link.", "invalid_login_link");
  return issueSession(dc, member, request, "login_link");
}

export async function listSessions(dc: DropwayContext, p: Principal) {
  const caller = requireMember(p);
  const { results } = await dc.env.DB.prepare("SELECT id, via, created_at AS createdAt, expires_at AS expiresAt, last_seen_at AS lastSeenAt, user_agent AS userAgent FROM sessions WHERE member_id = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at, id")
    .bind(caller.memberId, caller.tenantId, Date.now()).all();
  return { sessions: results };
}

export async function revokeSession(dc: DropwayContext, p: Principal, id: string) {
  const caller = requireMember(p);
  const row = await dc.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND member_id = ? AND tenant_id = ? AND revoked_at IS NULL RETURNING id")
    .bind(Date.now(), id, caller.memberId, caller.tenantId).first();
  if (!row) throw notFound("session_not_found", "Session not found.", "List your sessions and select one of their ids.");
  return { revoked: true, id };
}

export async function logoutSession(dc: DropwayContext, request: Request) {
  const caller = await resolveSession(dc, request);
  await dc.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND member_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), await sha256Hex(sessionToken(request)!), caller.memberId).run();
  return { cookie: sessionSetCookie("", true) };
}
