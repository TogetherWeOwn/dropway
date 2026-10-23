import type { Context } from "hono";
import { appOrigin, type DropwayContext } from "@dropway/core";
import type { DropwayEnv } from "../env";
import { escapeHtml } from "../escape";
import { THEME_COLORS } from "./design.generated";

/**
 * Colour modes: Auto (the default: CSS follows prefers-color-scheme, live), Light or Dark.
 *
 * An explicit choice is a cookie on the app origin, read by the server, which writes
 * <html data-theme="..."> into the first byte of the page: no flash of the wrong theme, and no
 * inline or blocking script. Auto means no cookie. `?theme=light|dark|auto` applies to one response
 * only (never stored) and wins over the cookie.
 *
 * Site-origin pages never read or set the cookie (it is not sent there, a cookie on a user-site host
 * would be readable by that site's scripts, and until the sites domain is on the Public Suffix List
 * sibling sites count as one site). They follow Auto in CSS and honour `?theme=` on pages Kofra
 * generates (system pages, password gate, listings, viewers): the app's file viewer passes it on.
 */
export type ThemePref = "auto" | "light" | "dark";
export type ThemeMode = "light" | "dark";

/** `dw_` stays the internal prefix (like the other cookies); __Host- pins it to this host, Path=/, Secure. */
export const THEME_COOKIE = "__Host-dw_theme";
/** Not HttpOnly: the dashboard script switches modes without a reload and writes the same cookie. */
export const THEME_COOKIE_ATTRS = "Path=/; Secure; SameSite=Lax; Max-Age=31536000";
export const THEME_PATH = "/__dropway/theme";

const PREFS: readonly ThemePref[] = ["auto", "light", "dark"];
export const isThemePref = (v: unknown): v is ThemePref => typeof v === "string" && (PREFS as readonly string[]).includes(v);

/** The cookie's value, if it holds an explicit mode. */
export function themeFromCookie(header: string | null | undefined): ThemeMode | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== THEME_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    return v === "light" || v === "dark" ? v : null;
  }
  return null;
}

/** `?theme=` on the request, if valid. */
export function themeFromQuery(url: URL | string): ThemePref | null {
  const v = (typeof url === "string" ? new URL(url) : url).searchParams.get("theme");
  return isThemePref(v) ? v : null;
}

/** The mode for this response: ?theme= (this response only) > cookie (app origin only) > auto. */
export function requestTheme(req: Request, opts: { cookie: boolean }): ThemePref {
  return themeFromQuery(req.url) ?? (opts.cookie ? themeFromCookie(req.headers.get("cookie")) : null) ?? "auto";
}

const bound = new WeakMap<DropwayContext, ThemePref>();

/** Remember the request's colour mode on its context (createDropway does this for every request). */
export function bindRequestTheme(dw: DropwayContext, req: Request, opts: { cookie?: boolean } = {}): ThemePref {
  const pref = requestTheme(req, { cookie: opts.cookie !== false });
  bound.set(dw, pref);
  return pref;
}

/** The colour mode bound to this request's context ("auto" when none was bound). */
export function themeOf(dw: DropwayContext): ThemePref {
  return bound.get(dw) ?? "auto";
}

/** ` data-theme="dark"` for an explicit mode, "" for Auto. */
export function themeAttr(pref: ThemePref): string {
  return pref === "auto" ? "" : ` data-theme="${pref}"`;
}

/** color-scheme and theme-color metas: both modes for Auto; only the chosen one when explicit, so browser auto-darkening never overrides it. */
export function themeMetas(pref: ThemePref): string {
  if (pref === "auto") {
    return `<meta name="color-scheme" content="light dark"><meta name="theme-color" media="(prefers-color-scheme: light)" content="${THEME_COLORS.light}"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="${THEME_COLORS.dark}">`;
  }
  const c = THEME_COLORS[pref];
  return `<meta name="color-scheme" content="only ${pref}"><meta name="theme-color" media="(prefers-color-scheme: light)" content="${c}"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="${c}">`;
}

/** Set-Cookie value for a choice: light or dark is stored for a year, auto deletes the cookie. */
export function themeSetCookie(pref: ThemePref): string {
  return pref === "auto" ? `${THEME_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0` : `${THEME_COOKIE}=${pref}; ${THEME_COOKIE_ATTRS}`;
}

/** A same-origin path to return to: starts with "/" (not "//"), no backslash, whitespace or control characters, at most 512 characters. Anything else is "/". */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next.length > 512 || !next.startsWith("/") || next.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(next)) return "/";
  return next;
}

/** The current path and query, without ?theme (the switch's return address). */
export function nextFor(url: URL | string): string {
  const u = typeof url === "string" ? new URL(url) : new URL(url.href);
  u.searchParams.delete("theme");
  return safeNext(u.pathname + u.search);
}

/**
 * POST /__dropway/theme: the mode switch's form target (works with no script at all).
 * Same-origin only (Origin, or Sec-Fetch-Site when there is no Origin); otherwise nothing changes.
 */
export async function themeRoute(c: Context<DropwayEnv>): Promise<Response> {
  const dw = c.get("dw");
  const origin = c.req.header("origin");
  const sameOrigin = origin ? origin === appOrigin(dw) : c.req.header("sec-fetch-site") === "same-origin";
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (!sameOrigin) {
    headers.set("Location", "/");
    return new Response(null, { status: 303, headers });
  }
  const form = await c.req.formData().catch(() => null);
  const next = safeNext(form?.get("next"));
  headers.set("Location", next);
  const theme = form?.get("theme");
  if (isThemePref(theme)) headers.append("Set-Cookie", themeSetCookie(theme));
  return new Response(null, { status: 303, headers });
}

/** Escaped `next` value for the switch form. */
export const nextValue = (url: URL | string) => escapeHtml(nextFor(url));
