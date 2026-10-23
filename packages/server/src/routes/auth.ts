import type { Hono, Context } from "hono";
import {
  createLoginLink, emailAvailable, listSessions, logoutSession, requestEmailCode,
  requireBrowserWrite, resolveSession, revokeSession, sessionSetCookie, sessionToken, verifyEmailCode,
} from "@dropway/core";
import type { DropwayEnv } from "../env";
import { readJson } from "./api";

async function input(c: Context<DropwayEnv>) {
  if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(await c.req.text()));
  return readJson(c);
}

/** Explicit browser-auth endpoints, not cookie authority for resource REST routes. */
export function installAuthRoutes(api: Hono<DropwayEnv>) {
  api.post("/login-links", async (c) => c.json(await createLoginLink(c.get("dw"), c.get("principal"), await readJson(c)), 201));
  api.get("/auth/sessions", async (c) => {
    const dw = c.get("dw");
    const principal = await resolveSession(dw, c.req.raw);
    c.header("Cache-Control", "no-store");
    c.header("Set-Cookie", sessionSetCookie(sessionToken(c.req.raw)!));
    return c.json(await listSessions(dw, principal));
  });
  api.delete("/auth/sessions/:id", async (c) => {
    const dw = c.get("dw");
    const principal = await resolveSession(dw, c.req.raw);
    return c.json(await revokeSession(dw, principal, c.req.param("id")));
  });
  api.post("/auth/logout", async (c) => {
    const result = await logoutSession(c.get("dw"), c.req.raw);
    c.header("Set-Cookie", result.cookie);
    if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/login", 303);
    return c.json({ signedOut: true });
  });
  api.post("/auth/email-code", async (c) => {
    const dw = c.get("dw");
    const body = await input(c);
    if (emailAvailable(dw) && c.req.header("Cookie")) requireBrowserWrite(dw, c.req.raw);
    const result = await requestEmailCode(dw, body);
    if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/login?code=1", 303);
    return c.json(result, 202);
  });
  api.post("/auth/email-code/verify", async (c) => {
    const dw = c.get("dw");
    if (emailAvailable(dw)) requireBrowserWrite(dw, c.req.raw);
    const result = await verifyEmailCode(dw, await input(c), c.req.raw);
    c.header("Set-Cookie", result.cookie);
    if (c.req.header("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return c.redirect("/dashboard/sessions", 303);
    return c.json({ signedIn: true });
  });
}
