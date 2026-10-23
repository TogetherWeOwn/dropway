/**
 * Instance configuration. Resolved from Worker vars/secrets (see wrangler.jsonc),
 * then overridden by whatever the embedding app passes to createDropway({ config }).
 */

const MB = 1024 * 1024;

/** Size and count caps applied to a publish. A PolicyAdapter may return different values per caller. */
export interface Limits {
  /** Largest single file in bytes. Workers request bodies are capped at 100 MB on most plans. */
  maxFileBytes: number;
  /** Most files in one version. */
  maxFiles: number;
  /** Largest version (sum of file sizes) in bytes. */
  maxSiteBytes: number;
  /** Largest request body for one-shot POST /api/v1/publish (held in memory). */
  oneShotMaxBytes: number;
}

export interface AnonymousConfig {
  /** Allow publishing without an API key. Off by default. */
  enabled: boolean;
  /** Lifetime of an anonymous site. */
  ttlMs: number;
  /** New anonymous sites per IP per hour. */
  sitesPerHourPerIp: number;
  /** Caps for anonymous sites. */
  limits: Limits;
}

export type SitesMode = "path" | "subdomain";

export interface DropwayConfig {
  /** Shown in pages and API responses. */
  instanceName: string;
  emailFrom: string | null;
  accessTeamDomain: string | null;
  accessAud: string | null;
  /** Public origin of the app + API, no trailing slash. null = the origin of each request. */
  appOrigin: string | null;
  /**
   * Former public origins of the app, for example a workers.dev hostname after a move to a domain.
   * On these hosts the API, MCP, /health, /.well-known/* and the agent documents keep working and
   * carry Deprecation + Link headers; other GET/HEAD requests 308 to appOrigin. Needs appOrigin.
   */
  legacyAppOrigins: string[];
  /** Deprecation date of the legacy origins, Unix seconds (header `Deprecation: @<seconds>`). */
  legacyDeprecatedAt: number;
  /**
   * subdomain: https://<slug>.<sitesDomain>/ (each site its own origin; recommended).
   * path: <sitesOrigin>/<slug>/ when sitesOrigin is set, else <appOrigin><sitesPathPrefix>/<slug>/ (interim, sandboxed).
   */
  sitesMode: SitesMode;
  sitesDomain: string | null;
  /** Path mode only: origin of a sites-only deployment. null = serve sites from the app origin. */
  sitesOrigin: string | null;
  /**
   * Former origins that served sites in path mode (<origin>/<slug>/<path>), for example a
   * workers.dev sites Worker after a move to subdomain mode. Requests there answer 308 to the
   * same path and query on the site's current URL.
   */
  legacySitesOrigins: string[];
  /** Path mode on the app origin: prefix in front of /<slug>/. */
  sitesPathPrefix: string;
  /**
   * Serve user content with a CSP sandbox (opaque origin: no cookies, storage, workers or Referer).
   * Always on when sites share the app origin. Off by default for a separate sites origin and for
   * subdomain mode (SITES_SANDBOX=true turns it on there).
   */
  sitesSandbox: boolean;
  /**
   * Sandbox anonymous (unclaimed, expiring) sites even when sitesSandbox is off, so
   * untrusted pages on a shared sites origin cannot read other sites' storage.
   * SITES_SANDBOX=auto (the default) turns this on for a separate sites origin;
   * subdomain mode gives every site its own origin and leaves it off.
   */
  sitesSandboxAnonymous: boolean;
  /** false (open source): exactly one tenant, created by POST /api/v1/setup. */
  multiTenant: boolean;
  anonymous: AnonymousConfig;
  /** Default caps for API-key publishes. */
  limits: Limits;
  /** Secret that may create the owner (first run) and mint recovery owner keys. */
  adminBootstrapKey: string | null;
  /** HMAC secret for cookies and IP hashing. */
  signingSecret: string;
  /** KV edge-cache TTL for live site manifests, seconds (KV minimum is 30). */
  liveCacheTtlSeconds: number;
}

export type ConfigOverrides = Partial<Omit<DropwayConfig, "anonymous" | "limits">> & {
  anonymous?: Partial<Omit<AnonymousConfig, "limits">> & { limits?: Partial<Limits> };
  limits?: Partial<Limits>;
};

/** Worker vars and secrets read by resolveConfig. All optional strings. */
export interface DropwayVars {
  INSTANCE_NAME?: string;
  EMAIL_FROM?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  APP_ORIGIN?: string;
  LEGACY_APP_ORIGINS?: string;
  LEGACY_DEPRECATED_AT?: string;
  SITES_MODE?: string;
  SITES_DOMAIN?: string;
  SITES_ORIGIN?: string;
  SITES_SANDBOX?: string;
  LEGACY_SITES_ORIGINS?: string;
  ANONYMOUS_PUBLISH?: string;
  ANON_TTL_HOURS?: string;
  ANON_SITES_PER_HOUR?: string;
  ANON_MAX_FILE_BYTES?: string;
  ANON_MAX_SITE_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_FILES?: string;
  MAX_SITE_BYTES?: string;
  ONESHOT_MAX_BYTES?: string;
  ADMIN_BOOTSTRAP_KEY?: string;
  SIGNING_SECRET?: string;
}

const num = (v: string | undefined, d: number) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const bool = (v: string | undefined, d: boolean) => {
  if (v === undefined || v.trim() === "") return d;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
};

export function normaliseOrigin(v: string | undefined | null): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  try {
    return new URL(s).origin;
  } catch {
    return null;
  }
}

/** Comma- or space-separated origins, normalised and de-duplicated; invalid entries are dropped. */
export function normaliseOrigins(v: string | undefined | null): string[] {
  return [...new Set((v ?? "").split(/[\s,]+/).map(normaliseOrigin).filter((o): o is string => o !== null))];
}

/** ISO 8601 date or Unix seconds -> Unix seconds (0 when unset or invalid). */
function unixSeconds(v: string | undefined): number {
  const s = (v ?? "").trim();
  if (!s) return 0;
  const n = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : 0;
}

function normaliseDomain(v: string | undefined | null): string | null {
  const d = (v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\.+|\.+$/g, "");
  return d || null;
}

export function resolveConfig(vars: DropwayVars, overrides: ConfigOverrides = {}): DropwayConfig {
  const sitesDomain = overrides.sitesDomain !== undefined ? overrides.sitesDomain : normaliseDomain(vars.SITES_DOMAIN);
  const requestedMode = (overrides.sitesMode ?? vars.SITES_MODE ?? "").trim().toLowerCase();
  let sitesMode: SitesMode = requestedMode === "subdomain" || (!requestedMode && sitesDomain) ? "subdomain" : "path";
  if (sitesMode === "subdomain" && !sitesDomain) {
    console.warn(JSON.stringify({ event: "config_warning", message: "SITES_MODE=subdomain needs SITES_DOMAIN; falling back to path mode." }));
    sitesMode = "path";
  }
  const appOrigin = overrides.appOrigin !== undefined ? overrides.appOrigin : normaliseOrigin(vars.APP_ORIGIN);
  // Legacy app origins only make sense with a fixed APP_ORIGIN to send people and agents to.
  const legacyAppOrigins = appOrigin ? (overrides.legacyAppOrigins ?? normaliseOrigins(vars.LEGACY_APP_ORIGINS)).filter((o) => o !== appOrigin) : [];
  const sitesOriginVar = overrides.sitesOrigin !== undefined ? overrides.sitesOrigin : normaliseOrigin(vars.SITES_ORIGIN);
  // The effective sites origin. SITES_ORIGIN applies in path mode only: subdomain mode ignores it,
  // so a value left over from path mode must not drop that origin from LEGACY_SITES_ORIGINS below.
  const sitesOrigin = sitesMode === "path" && sitesOriginVar !== appOrigin ? sitesOriginVar : null;
  const legacySitesOrigins =
    overrides.legacySitesOrigins ??
    [...new Set((vars.LEGACY_SITES_ORIGINS ?? "").split(/[\s,]+/).map(normaliseOrigin))].filter(
      (o): o is string => o !== null && o !== appOrigin && o !== sitesOrigin,
    );
  const sharedOrigin = sitesMode === "path" && !sitesOrigin;
  // SITES_SANDBOX: true (every site), false (none, unless sites share the app origin), auto (default: anonymous sites on a sites origin).
  const sandboxVar = (vars.SITES_SANDBOX ?? "").trim().toLowerCase();
  const sandboxAuto = sandboxVar === "" || sandboxVar === "auto";
  const sandboxRequested = overrides.sitesSandbox ?? (sandboxAuto ? false : bool(sandboxVar, false));
  const limits: Limits = {
    maxFileBytes: num(vars.MAX_FILE_BYTES, 100 * MB),
    maxFiles: num(vars.MAX_FILES, 2500),
    maxSiteBytes: num(vars.MAX_SITE_BYTES, 10 * 1024 * MB),
    oneShotMaxBytes: num(vars.ONESHOT_MAX_BYTES, 25 * MB),
    ...overrides.limits,
  };
  const anonymous: AnonymousConfig = {
    enabled: bool(vars.ANONYMOUS_PUBLISH, false),
    ttlMs: num(vars.ANON_TTL_HOURS, 24) * 3600_000,
    sitesPerHourPerIp: num(vars.ANON_SITES_PER_HOUR, 60),
    ...overrides.anonymous,
    limits: {
      maxFileBytes: num(vars.ANON_MAX_FILE_BYTES, 25 * MB),
      maxFiles: limits.maxFiles,
      maxSiteBytes: num(vars.ANON_MAX_SITE_BYTES, 250 * MB),
      oneShotMaxBytes: limits.oneShotMaxBytes,
      ...overrides.anonymous?.limits,
    },
  };
  const adminBootstrapKey = overrides.adminBootstrapKey !== undefined ? overrides.adminBootstrapKey : vars.ADMIN_BOOTSTRAP_KEY?.trim() || null;
  return {
    instanceName: overrides.instanceName ?? (vars.INSTANCE_NAME?.trim() || "Dropway"),
    emailFrom: overrides.emailFrom ?? (vars.EMAIL_FROM?.trim() || null),
    accessTeamDomain: overrides.accessTeamDomain ?? (vars.ACCESS_TEAM_DOMAIN?.trim() || null),
    accessAud: overrides.accessAud ?? (vars.ACCESS_AUD?.trim() || null),
    appOrigin,
    legacyAppOrigins,
    legacyDeprecatedAt: overrides.legacyDeprecatedAt ?? unixSeconds(vars.LEGACY_DEPRECATED_AT),
    sitesMode,
    sitesDomain: sitesMode === "subdomain" ? sitesDomain : null,
    sitesOrigin,
    legacySitesOrigins,
    sitesPathPrefix: (overrides.sitesPathPrefix ?? "/s").replace(/\/+$/, ""),
    // Sites that share the app origin are always sandboxed: they must never touch the app's storage.
    sitesSandbox: sharedOrigin ? true : sandboxRequested,
    sitesSandboxAnonymous: overrides.sitesSandboxAnonymous ?? (sandboxAuto && sitesMode === "path"),
    multiTenant: overrides.multiTenant ?? false,
    anonymous,
    limits,
    adminBootstrapKey,
    signingSecret: overrides.signingSecret ?? (vars.SIGNING_SECRET?.trim() || adminBootstrapKey || "dropway-insecure-dev-secret"),
    liveCacheTtlSeconds: Math.max(30, overrides.liveCacheTtlSeconds ?? 30),
  };
}
