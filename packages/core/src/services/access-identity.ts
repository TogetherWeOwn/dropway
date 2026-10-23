import type { DropwayContext } from "../context";
import { unauthorized } from "../errors";
import type { Principal } from "../principal";
import { memberPrincipal } from "./sessions";
import type { MemberRow } from "./tenants";
import { accessVerificationKey } from "./access-jwks";

function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
function object(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(new TextDecoder().decode(bytes(value)));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid JWT object");
  return result as Record<string, unknown>;
}

/** Never trust the email header, token-supplied key URLs, or decoded claims alone. */
export async function resolveAccessIdentity(dc: DropwayContext, token: string, ip: string): Promise<Principal> {
  const denied = () => unauthorized("The Access assertion is invalid or does not identify an existing member.", "Use the configured Access application and an existing member email.", "invalid_access_identity");
  try {
    const domain = dc.config.accessTeamDomain;
    const audience = dc.config.accessAud;
    if (!domain || !audience || token.length > 16384) throw denied();
    const issuer = new URL(domain.includes("://") ? domain : `https://${domain}`);
    if (issuer.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.port || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash) throw denied();
    const parts = token.split(".");
    if (parts.length !== 3) throw denied();
    const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
    const header = object(encodedHeader);
    const payload = object(encodedPayload);
    const now = Date.now() / 1000;
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256 || header.crit !== undefined) throw denied();
    const aud = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    if (payload.iss !== issuer.origin || !Array.isArray(aud) || !aud.includes(audience) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now ||
      (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > now)) ||
      (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isFinite(payload.iat) || payload.iat > now)) ||
      (payload.type !== undefined && payload.type !== "app") || typeof payload.email !== "string" || payload.email.length > 254) throw denied();
    const { key, expiresAt } = await accessVerificationKey(issuer.origin, header.kid);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(signature), new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`))) throw denied();
    if (Date.now() >= expiresAt || payload.exp <= Date.now() / 1000) throw denied();
    const { results } = await dc.env.DB.prepare("SELECT m.* FROM members m JOIN tenants t ON t.id = m.tenant_id WHERE m.email = ? AND m.disabled_at IS NULL AND t.disabled_at IS NULL LIMIT 2")
      .bind(payload.email.trim().toLowerCase()).all<MemberRow>();
    if (results.length !== 1) throw denied();
    return memberPrincipal(results[0]!, ip, "access");
  } catch { throw denied(); }
}
