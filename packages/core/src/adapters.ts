/**
 * Extension points. The open-source worker uses the defaults below; an embedding
 * app (for example a hosted, multi-tenant layer) passes its own implementations
 * to createDropway({ adapters, hooks }). Nothing in this package knows about
 * plans, prices or billing; those live entirely in adapters supplied from outside.
 */
import type { Limits } from "./config";
import type { DropwayContext } from "./context";
import type { Principal } from "./principal";
import type { Capability, CapabilityDecision, OperationMeta, QuotaKey } from "./policy";

/** Resolves the caller of a request. Owns tenancy: a member principal names its tenant. */
export interface IdentityAdapter {
  /**
   * Return the principal for this request. Throw an ApiError (401) for a
   * credential that is present but invalid; return { kind: "anonymous" } when
   * there is none.
   */
  resolve(request: Request, dc: DropwayContext): Promise<Principal>;
}

/** The owner a site belongs to, as seen by policy checks. */
export interface SiteOwner {
  siteId: string | null;
  tenantId: string | null;
}

/** Limits and allow/deny decisions. Throw an ApiError to refuse. */
export interface PolicyAdapter {
  /** Caps for a publish by `principal` to a site owned by `owner`. */
  limits(principal: Principal, owner: SiteOwner, dc: DropwayContext): Limits | Promise<Limits>;
  /** Called before a site is created. */
  beforeCreateSite?(principal: Principal, input: { slug: string | null; tenantId: string | null }, dc: DropwayContext): void | Promise<void>;
  /** Called before a deploy is recorded, with its totals. */
  beforeDeploy?(
    principal: Principal,
    input: { siteId: string; tenantId: string | null; fileCount: number; totalBytes: number; newBytes: number },
    dc: DropwayContext,
  ): void | Promise<void>;
  /** Core checks instance support before consulting the adapter. */
  capability?(principal: Principal, capability: Capability, owner: SiteOwner | null, dc: DropwayContext): CapabilityDecision | Promise<CapabilityDecision>;
  /** null means unlimited; omitted hooks use the instance's configured quotas. */
  quota?(principal: Principal, key: QuotaKey, owner: SiteOwner | null, dc: DropwayContext): number | null | Promise<number | null>;
  /** After authorization and validation, before registry dispatch. */
  beforeOperation?(principal: Principal, op: OperationMeta, input: unknown, dc: DropwayContext): void | Promise<void>;
}

export type UsageEvent =
  | { type: "deploy"; tenantId: string | null; siteId: string; versionId: string; fileCount: number; totalBytes: number; at: number }
  | { type: "blob_upload"; tenantId: string | null; sha256: string; bytes: number; at: number }
  | { type: "site_request"; tenantId: string | null; siteId: string; status: number; bytes: number; at: number }
  | { type: "site_created"; tenantId: string | null; siteId: string; anonymous: boolean; at: number }
  | { type: "site_deleted"; tenantId: string | null; siteId: string; at: number }
  | { type: "storage_snapshot"; tenantId: string; bytes: number; at: number };

/** Usage metering. The default does nothing. Called off the hot path (waitUntil). */
export interface MeteringAdapter {
  record(event: UsageEvent, dc: DropwayContext): void | Promise<void>;
}

export interface DropwayAdapters {
  identity: IdentityAdapter;
  policy: PolicyAdapter;
  metering: MeteringAdapter;
}

/** Minimal description of a site passed to hooks. */
export interface SiteRef {
  id: string;
  slug: string;
  tenantId: string | null;
  url: string;
}

export interface PublishEvent {
  /** "deploy": a new version went live. "restore": an older version was made live again. */
  kind: "deploy" | "restore";
  site: SiteRef;
  version: { id: string; number: number; fileCount: number; totalBytes: number };
  principal: Principal;
  at: number;
}

export interface DeleteEvent {
  site: SiteRef;
  principal: Principal | null;
  /** "api": deleted by its owner. "expired": anonymous site reached its expiry. */
  reason: "api" | "expired";
  at: number;
}

export interface SiteRequestEvent {
  site: { id: string; slug: string; tenantId: string | null; versionId: string | null };
  path: string;
  status: number;
  bytes: number;
  ms: number;
  request: Request;
}

/**
 * Event hooks. All run after the response is sent (waitUntil); errors are
 * logged and never affect the request. Use PolicyAdapter to block things.
 */
export interface DropwayHooks {
  onPublish?(event: PublishEvent, dc: DropwayContext): void | Promise<void>;
  onDelete?(event: DeleteEvent, dc: DropwayContext): void | Promise<void>;
  /** Every request served for a site (including 404s). Keep it cheap. */
  onRequest?(event: SiteRequestEvent, dc: DropwayContext): void | Promise<void>;
}

/** Default policy: the instance's configured limits; anonymous sites get the anonymous caps. */
export const defaultPolicy: PolicyAdapter = {
  limits(_principal, owner, dc) {
    return owner.tenantId === null ? dc.config.anonymous.limits : dc.config.limits;
  },
  capability() { return { allowed: true }; },
  quota(_principal, key, _owner, dc) { return dc.config.quotas[key]; },
};

/** Default metering: none. */
export const noopMetering: MeteringAdapter = {
  record() {},
};
