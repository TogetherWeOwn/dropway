import { escapeHtml } from "../escape";
import { THEME_PATH, type ThemePref } from "./theme";

/**
 * The page chrome shared by every app-origin page, in the core and in embedding apps (one header,
 * one footer): skip link, header (wordmark, tag, navigation, account area, colour mode switch),
 * footer (wordmark, domains, links, the trust line on pages that show files). Site-origin pages get
 * a minimal header (a small wordmark linking to the app) and a footer.
 */
const e = escapeHtml;

const ICONS: Record<ThemePref, string> = {
  auto: '<circle cx="8" cy="8" r="6.25"/><path d="M8 1.75v12.5a6.25 6.25 0 0 0 0-12.5z" fill="currentColor" stroke="none"/>',
  light: '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/>',
  dark: '<path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z"/>',
};
const LABELS: Record<ThemePref, [string, string]> = {
  auto: ["Auto", "Follow your device setting"],
  light: ["Light", "Always light"],
  dark: ["Dark", "Always dark"],
};

/** The trust line, verbatim (DESIGN.md section 10). Kofra never claims a file is safe. */
export const TRUST_LINE = "Kofra does not scan files; open files only from people you trust.";

/**
 * Auto / Light / Dark as submit buttons posting to /__dropway/theme: works on pages with no script at
 * all. Where the dashboard script runs it switches in place, without a reload. `next` is the current
 * path and query (escaped here).
 */
export function modeSwitch(pref: ThemePref, next: string): string {
  const buttons = (["auto", "light", "dark"] as const)
    .map((v) => {
      const [label, title] = LABELS[v];
      return `<button type="submit" name="theme" value="${v}" aria-pressed="${pref === v}" title="${title}"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">${ICONS[v]}</svg><span data-label="${label}">${label}</span></button>`;
    })
    .join("");
  return `<form class="k-mode-switch" method="post" action="${THEME_PATH}"><input type="hidden" name="next" value="${e(next)}"><div role="group" aria-label="Colour theme">${buttons}</div></form>`;
}

export interface ChromeNavItem {
  label: string;
  href: string;
}

export interface AppHeaderOptions {
  /** The instance name (shown as the wordmark; styled lowercase by CSS, the text keeps its case). */
  name: string;
  /** Where the wordmark links (default "/"). */
  home?: string;
  /** Small mono line after the wordmark, e.g. "@handle · email" (plain text). */
  tag?: string;
  nav?: ChromeNavItem[];
  /** href of the current nav item (aria-current="page"). */
  active?: string;
  /** Trusted HTML for the account area (sign-in link, or the person and a sign-out form). */
  account?: string;
  /** id for the account area (the dashboard script fills "dw-account"). */
  accountId?: string;
  theme: ThemePref;
  /** Current path and query, for the switch's return address. */
  next: string;
  /** Show the mode switch (default true; pages whose CSP blocks form posts set false). */
  modeSwitch?: boolean;
  navLabel?: string;
}

export function appHeader(o: AppHeaderOptions): string {
  const nav = o.nav?.length
    ? `<nav class="k-nav" aria-label="${e(o.navLabel ?? "Main")}">${o.nav
        .map((n) => `<a href="${e(n.href)}"${n.href === o.active ? ' aria-current="page"' : ""}>${e(n.label)}</a>`)
        .join("")}</nav>`
    : "";
  return `<header class="k-top"><div class="k-wrap"><a class="k-wm" href="${e(o.home ?? "/")}">${e(o.name)}</a>${o.tag ? `<span class="k-tag">${e(o.tag)}</span>` : ""}${nav}<div class="k-acct"${o.accountId ? ` id="${e(o.accountId)}"` : ""}>${o.account ?? ""}</div>${o.modeSwitch === false ? "" : modeSwitch(o.theme, o.next)}</div></header>`;
}

export interface AppFooterOptions {
  name: string;
  home?: string;
  /** Plain-text domains line, e.g. "kofra.app · sites on <slug>.kofra.io". */
  domains?: string;
  links?: ChromeNavItem[];
  /** Show the trust line (every page that shows files). */
  trust?: boolean;
}

export function appFooter(o: AppFooterOptions): string {
  const links = (o.links ?? []).map((l) => `<a href="${e(l.href)}">${e(l.label)}</a>`).join("");
  return `<footer class="k-foot"><div class="k-wrap"><a class="k-wm" href="${e(o.home ?? "/")}">${e(o.name)}</a>${o.domains ? `<span>${e(o.domains)}</span>` : ""}${links ? `<nav class="k-end" aria-label="Footer">${links}</nav>` : ""}${o.trust ? `<p class="k-trust">${TRUST_LINE}</p>` : ""}</div></footer>`;
}

export const SKIP_LINK = '<a class="k-skip" href="#dw-main">Skip to content</a>';

export interface AppChromeOptions {
  header: AppHeaderOptions;
  footer?: AppFooterOptions | null;
  /** Trusted HTML shown in a strip under the header (uiSlots.banner). */
  banner?: string | null;
  /** Trusted HTML for <main>. */
  main: string;
  mainClass?: string;
  /** Trusted HTML after the footer (toasts, noscript). */
  after?: string;
}

/** Skip link + header + optional banner + <main id="dw-main"> + footer: the body of an app page. */
export function appChrome(o: AppChromeOptions): string {
  return `${SKIP_LINK}${appHeader(o.header)}${o.banner ? `<div class="k-slotbanner" role="status"><div class="k-wrap">${o.banner}</div></div>` : ""}<main id="dw-main" class="${e(o.mainClass ?? "k-main")}">${o.main}</main>${o.footer ? appFooter(o.footer) : ""}${o.after ?? ""}`;
}

/** Minimal header for site-origin pages: a small wordmark that links to the app. */
export function siteHeader(name: string, appOrigin: string): string {
  return `<header class="k-sitehead"><div class="k-wrap"><a class="k-wm" href="${e(appOrigin)}" rel="nofollow">${e(name)}</a></div></header>`;
}

/** Footer for site-origin pages: domains line, plus the trust line on pages that show files. */
export function siteFooter(o: { name: string; appOrigin: string; domains?: string; trust?: boolean }): string {
  return `<footer class="k-foot"><div class="k-wrap"><a class="k-wm" href="${e(o.appOrigin)}" rel="nofollow">${e(o.name)}</a>${o.domains ? `<span>${e(o.domains)}</span>` : ""}${o.trust ? `<p class="k-trust">${TRUST_LINE}</p>` : ""}</div></footer>`;
}
