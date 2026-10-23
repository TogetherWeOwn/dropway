import type { Hono } from "hono";
import { ApiError, consumeLoginLink } from "@dropway/core";
import { installSigninUi, loginConfirmationPage } from "./signin";
import type { DropwayEnv } from "../env";
import type { UiSlots } from "../extensions";
import { clientScriptResponse } from "./assets";
import { keysPage, loginPage, publishPage, settingsPage, sitePage, sitesPage, viewerPage } from "./pages";

/**
 * App-origin UI routes: sign-in, dashboard, file viewer and the dashboard
 * script. Registered after uiSlots.pages, so an embedding app can replace any
 * of these paths with its own page. The home page (GET /) is wired in app.ts
 * (uiSlots.landing replaces it).
 */
export function installUi(app: Hono<DropwayEnv>, slots: UiSlots) {
  installSigninUi(app);
  app.get("/__dropway/ui/:file", (c) => clientScriptResponse(c.req.param("file")) ?? c.notFound());
  app.get("/login", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.query("token") !== undefined) {
      try {
        // Modern browser requests carry Fetch Metadata; explicit programmatic
        // GET clients retain the one-use exchange contract without these headers.
        if (["Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-Site"].some((name) => c.req.header(name) !== undefined)) {
          return await loginConfirmationPage(c, c.req.query("token")!);
        }
        const session = await consumeLoginLink(c.get("dw"), c.req.query("token"), c.req.raw);
        c.header("Set-Cookie", session.cookie);
        return c.redirect("/dashboard/sessions", 303);
      } catch (err) {
        if (err instanceof ApiError && err.code === "session_account_mismatch") return c.text(`${err.message} ${err.hint ?? ""}`, 403);
        return c.redirect("/login?invalid=1", 303);
      }
    }
    return loginPage(c);
  });
  // The sign-in forms post here only if the dashboard script has not loaded yet: never echo or
  // store what was sent (it may be a key), just send the person back. Secrets never land in a URL.
  app.post("/login", (c) => c.redirect("/login?retry=1", 303));
  app.get("/dashboard", (c) => sitesPage(c));
  app.get("/dashboard/", (c) => c.redirect("/dashboard", 301));
  app.get("/dashboard/sites/:slug", (c) => sitePage(c));
  app.get("/dashboard/publish", (c) => publishPage(c));
  app.get("/dashboard/keys", (c) => keysPage(c));
  app.get("/dashboard/settings", (c) => settingsPage(c, slots));
  app.get("/v/:slug", (c) => c.redirect(`/v/${encodeURIComponent(c.req.param("slug"))}/`, 301));
  app.get("/v/:slug/*", (c) => viewerPage(c));
  // SPEC 8.3 names the viewer /view/{site}/{path}; keep that address working.
  app.get("/view/:slug/*", (c) => {
    const u = new URL(c.req.url);
    return c.redirect(u.pathname.replace(/^\/view\//, "/v/") + u.search, 301);
  });
}

export { homePage } from "./pages";
export { renderAppPage, bindUiSlots, appScriptCsp, APP_CSS, CORE_NAV, type AppPageOptions } from "./shell";
export { clientScriptUrl, CLIENT_SCRIPT } from "./assets";
