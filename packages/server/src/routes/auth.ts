import type { Context } from "hono";
import {
  browserWriteAllowed, createLoginLink, emailAvailable, listSessions, logoutSession, refreshSession, requestEmailCode,
  requireBrowserWrite, resolveSession, revokeSession, sessionSetCookie, sessionToken, verifyEmailCode,
} from "@dropway/core";
import type { DropwayEnv } from "../env";
import { defineOperation } from "../operations";
import { fromSchema, RO, WRITE } from "../operations/shared";
import { readJson } from "./api";
import { readForm } from "./forms";

async function input(c: Context<DropwayEnv>) {
  // Disabled email preserves the service's feature_unavailable refusal, not a parser error.
  if (!emailAvailable(c.get("dw"))) return {};
  if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(await readForm(c));
  return readJson(c);
}

const object = fromSchema({ type: "object" });
const empty = fromSchema({ type: "object", properties: {} });
const emailInput = fromSchema({ type: "object", properties: { email: { type: "string" }, code: { type: "string" } } });
const browserOnly = { exclude: "Explicit browser authentication; ordinary resource REST and MCP do not accept session cookies." };

/** Cookie operations opt out of bearer authorization, not authentication: services resolve the real session. */
export const AUTH_OPERATIONS = [
  defineOperation({
    id: "create_login_link", method: "POST", path: "/api/v1/login-links", toolset: "members", scopes: ["sites:write"],
    summary: "Create a login link",
    description: "Create a one-use browser sign-in link for an existing member (15 minutes). Members may mint only for themselves; administrators need member authority for others. Restricted API keys cannot mint member sessions. Treat the returned URL as a secret.",
    input: fromSchema({ type: "object", properties: { memberId: { type: "string" } }, additionalProperties: false }),
    output: fromSchema({ type: "object", properties: { url: { type: "string" }, expiresAt: { type: "number" } }, required: ["url", "expiresAt"] }),
    annotations: { ...WRITE, idempotentHint: false },
    handler: (args, { dw, principal }) => createLoginLink(dw, principal, args),
    http: { status: 201 },
    tool: { summarize: () => "Created a one-use login link; it expires in 15 minutes." },
    examples: [{ input: {}, output: { url: "https://dropway.example/login?token=dwl_example", expiresAt: 1792753200000 } }],
  }),
  defineOperation({
    id: "list_sessions", method: "GET", path: "/api/v1/auth/sessions", toolset: "auth", scopes: [], anonymous: true,
    summary: "List your browser sessions",
    description: "Requires the actual __Host-dw_session cookie, not a bearer key. List this member's live sessions. Renewal requires both exact app Origin and Sec-Fetch-Site: same-origin; ordinary navigation is read-only.",
    input: empty, output: object, annotations: RO, mcp: browserOnly,
    handler: async (_args, { dw, request }) => listSessions(dw, await resolveSession(dw, request)),
    http: { handler: async (c) => {
      const dw = c.get("dw");
      const principal = await resolveSession(dw, c.req.raw);
      c.header("Cache-Control", "no-store");
      if (browserWriteAllowed(dw, c.req.raw)) c.header("Set-Cookie", sessionSetCookie(sessionToken(c.req.raw)!));
      return c.json(await listSessions(dw, principal));
    } },
    examples: [{ input: {}, output: { sessions: [] } }],
  }),
  defineOperation({
    id: "refresh_session", method: "POST", path: "/api/v1/auth/sessions/refresh", toolset: "auth", scopes: [], anonymous: true,
    summary: "Renew this browser session after first-party activity",
    description: "Requires the actual __Host-dw_session cookie, exact app Origin and Sec-Fetch-Site: same-origin. After one hour, renew both D1 authority and the same host-only cookie. An empty body is accepted; bearer credentials cannot substitute for the cookie.",
    input: empty, output: object, annotations: WRITE, mcp: browserOnly,
    handler: async (_args, { dw, request }) => refreshSession(dw, request),
    http: { handler: async (c) => {
      const result = await refreshSession(c.get("dw"), c.req.raw);
      c.header("Cache-Control", "no-store");
      if (result.cookie) c.header("Set-Cookie", result.cookie);
      return c.json({ refreshed: true });
    } },
    examples: [{ input: {}, output: { refreshed: true } }],
  }),
  defineOperation({
    id: "revoke_session", method: "DELETE", path: "/api/v1/auth/sessions/{id}", toolset: "auth", scopes: [], anonymous: true,
    summary: "Revoke your browser session",
    description: "Requires the actual __Host-dw_session cookie, exact app Origin and Sec-Fetch-Site: same-origin. Revoke only a session belonging to the signed-in member.",
    input: fromSchema({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }), output: object,
    annotations: WRITE, mcp: browserOnly,
    handler: async (args, { dw, request }) => revokeSession(dw, await resolveSession(dw, request), String(args.id)),
    examples: [{ input: { id: "ses_example" }, output: { revoked: true, id: "ses_example" } }],
  }),
  defineOperation({
    id: "logout", method: "POST", path: "/api/v1/auth/logout", toolset: "auth", scopes: [], anonymous: true,
    summary: "Sign out this browser session",
    description: "Requires the actual __Host-dw_session cookie, exact app Origin and Sec-Fetch-Site: same-origin. Revoke this session and expire its host-only cookie.",
    input: empty, output: object, annotations: WRITE, mcp: browserOnly,
    handler: async (_args, { dw, request }) => logoutSession(dw, request),
    http: { contentTypes: ["application/json", "application/x-www-form-urlencoded"], handler: async (c) => {
      const result = await logoutSession(c.get("dw"), c.req.raw);
      c.header("Cache-Control", "no-store");
      c.header("Set-Cookie", result.cookie);
      if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/login", 303);
      return c.json({ signedOut: true });
    } },
    examples: [{ input: {}, output: { signedOut: true } }],
  }),
  defineOperation({
    id: "request_email_code", method: "POST", path: "/api/v1/auth/email-code", toolset: "auth", scopes: [], anonymous: true,
    summary: "Request an existing member sign-in code",
    description: "Optional email sign-in. Enabled requests require exact app Origin and Sec-Fetch-Site: same-origin, even without cookies. Never creates a new member. Enabled URL-encoded forms accept at most 65,536 wire bytes; oversized forms return 413 request_too_large before delivery or challenge changes. Without EmailAdapter or EMAIL returns feature_unavailable.",
    input: emailInput, output: object, annotations: { ...WRITE, idempotentHint: false }, mcp: browserOnly,
    handler: async (args, { dw, request }) => {
      if (emailAvailable(dw)) requireBrowserWrite(dw, request);
      return requestEmailCode(dw, args);
    },
    http: { statuses: [202, 303], contentTypes: ["application/json", "application/x-www-form-urlencoded"], handler: async (c) => {
      const dw = c.get("dw");
      if (emailAvailable(dw)) requireBrowserWrite(dw, c.req.raw);
      const result = await requestEmailCode(dw, await input(c));
      c.header("Cache-Control", "no-store");
      if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/login?code=1", 303);
      return c.json(result, 202);
    } },
    examples: [{ input: { email: "person@example.com" }, output: { accepted: true, message: "If this email belongs to an existing member, a code will be sent. Check your inbox." } }],
  }),
  defineOperation({
    id: "verify_email_code", method: "POST", path: "/api/v1/auth/email-code/verify", toolset: "auth", scopes: [], anonymous: true,
    summary: "Exchange a sign-in code for a browser session",
    description: "Optional existing-member sign-in, with five attempts and a 15-minute window. Requires HTTPS app origin, exact Origin and Sec-Fetch-Site: same-origin before exchanging a code. URL-encoded forms accept at most 65,536 wire bytes; oversized forms return 413 request_too_large before proof or session changes. Without email transport returns feature_unavailable.",
    input: emailInput, output: object, annotations: { ...WRITE, idempotentHint: false }, mcp: browserOnly,
    handler: async (args, { dw, request }) => {
      if (emailAvailable(dw)) requireBrowserWrite(dw, request);
      return verifyEmailCode(dw, args, request);
    },
    http: { statuses: [200, 303], contentTypes: ["application/json", "application/x-www-form-urlencoded"], handler: async (c) => {
      const dw = c.get("dw");
      if (emailAvailable(dw)) requireBrowserWrite(dw, c.req.raw);
      const result = await verifyEmailCode(dw, await input(c), c.req.raw);
      c.header("Cache-Control", "no-store");
      c.header("Set-Cookie", result.cookie);
      if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/dashboard/sessions", 303);
      return c.json({ signedIn: true });
    } },
    examples: [{ input: { email: "person@example.com", code: "123456" }, output: { signedIn: true } }],
  }),
];
