import type { ApiError } from "./errors";
import type { Scope } from "./principal";

export const CAPABILITIES = [
  "anonymous_publish", "url_fetch", "large_uploads", "version_previews", "site_password", "site_restricted", "site_private",
  "share_links", "embed_allowlist", "custom_domains", "mounts", "vanity_names", "site_data", "variables", "proxy_routes", "drives",
  "functions", "analytics", "screenshots", "ai_metadata", "search", "comments", "webhooks", "code_mode", "members", "api_keys", "audit_log",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityDecision = { allowed: true } | { allowed: false; error: ApiError };

export const QUOTA_KEYS = [
  "sites", "storage_bytes", "custom_domains", "members", "api_keys_per_member", "folders", "variables", "drives",
  "site_data_records_per_site", "share_links_per_site", "webhooks", "analytics_retention_days", "versions_per_site",
] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
export type Quotas = Record<QuotaKey, number | null>;

/** Transport-independent metadata passed to policy, without schemas or a handler. */
export interface OperationMeta {
  id: string;
  toolset: string;
  method: string;
  path: string;
  scopes: readonly Scope[];
}
