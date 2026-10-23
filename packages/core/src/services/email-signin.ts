import type { EmailAdapter } from "../adapters";
import { appOrigin, type DropwayContext } from "../context";
import { ApiError, badRequest, forbidden, unauthorized } from "../errors";
import { hmacHex, newId } from "../lib/crypto";
import { activeMember, issueSession, resolveSession, sessionToken, SIGN_IN_TTL } from "./sessions";
import type { MemberRow } from "./tenants";

export function emailAvailable(dc: DropwayContext): boolean {
  return !!(dc.adapters.email || dc.env.EMAIL);
}

function emailAdapter(dc: DropwayContext): EmailAdapter {
  if (dc.adapters.email) return dc.adapters.email;
  if (dc.env.EMAIL) return { async send(message, context) {
    const { kind: _kind, ...mail } = message;
    const result = await context.env.EMAIL!.send({ ...mail, from: context.config.emailFrom ?? `noreply@${new URL(appOrigin(context)).hostname}` });
    return { id: result.messageId };
  } };
  throw new ApiError(501, "feature_unavailable", "Email sign-in is not available on this instance.", "Ask the owner for a login link, or configure EMAIL or an EmailAdapter.");
}

function emailAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) throw badRequest("invalid_email", "Enter a valid email address.", "Use your existing member email.");
  return value.trim().toLowerCase();
}

async function memberByEmail(dc: DropwayContext, email: string) {
  // Fail closed on ambiguous multi-tenant matches; core never signs new members up.
  const { results } = await dc.env.DB.prepare("SELECT m.* FROM members m JOIN tenants t ON t.id = m.tenant_id WHERE m.email = ? AND m.disabled_at IS NULL AND t.disabled_at IS NULL LIMIT 2")
    .bind(email).all<MemberRow>();
  return results.length === 1 ? results[0]! : null;
}

export async function requestEmailCode(dc: DropwayContext, input: { email?: unknown }) {
  const adapter = emailAdapter(dc);
  const email = emailAddress(input.email);
  const member = await memberByEmail(dc, email);
  const accepted = { accepted: true, message: "If this email belongs to an existing member, a code will be sent. Check your inbox." };
  if (!member) return accepted;
  const now = Date.now();
  const id = newId("emc");
  // Rejection sampling gives an unbiased six-digit code.
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0]! >= 4294000000);
  const code = String(random[0]! % 1000000).padStart(6, "0");
  const hash = await hmacHex(dc.config.signingSecret, `${id}:${email}:${code}`);
  // A resend cannot reset the guessing budget or flood the member's mailbox.
  const inserted = await dc.env.DB.prepare("INSERT INTO email_codes (id, purpose, email, code_hash, created_at, expires_at) SELECT ?, 'sign_in', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM email_codes WHERE email = ? AND purpose = 'sign_in' AND expires_at > ?) RETURNING id")
    .bind(id, email, hash, now, now + SIGN_IN_TTL, email, now).first();
  if (!inserted) return accepted;
  try {
    await adapter.send({ to: [email], subject: "Your Dropway sign-in code", text: `Your sign-in code is ${code}. It expires in 15 minutes. If you did not request it, ignore this email.`, kind: "sign_in" }, dc);
  } catch {
    await dc.env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ?").bind(Date.now(), id).run();
    throw new ApiError(503, "email_delivery_failed", "The sign-in email could not be delivered.", "Ask the owner for a login link or try again after 15 minutes.");
  }
  return accepted;
}

export async function verifyEmailCode(dc: DropwayContext, input: { email?: unknown; code?: unknown }, request: Request) {
  emailAdapter(dc);
  const email = emailAddress(input.email);
  const code = typeof input.code === "string" ? input.code : "";
  const invalid = () => unauthorized("The code is invalid, expired or has no attempts left.", "Request a new code after 15 minutes.", "invalid_email_code");
  const member = await memberByEmail(dc, email);
  if (!member) throw invalid();
  if (sessionToken(request)) {
    const current = await resolveSession(dc, request).catch(() => null);
    if (current && current.memberId !== member.id) throw forbidden("Sign out before signing in as a different member.", "Sign out deliberately, then try again.", "session_account_mismatch");
  }
  const challenge = await dc.env.DB.prepare("SELECT id FROM email_codes WHERE email = ? AND purpose = 'sign_in' AND used_at IS NULL AND attempts < 5 AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(email, Date.now()).first<{ id: string }>();
  if (!challenge) throw invalid();
  const hash = await hmacHex(dc.config.signingSecret, `${challenge.id}:${email}:${code.slice(0, 64)}`);
  // One conditional write reserves a try and consumes a match. Racing submissions
  // cannot both redeem, nor can concurrent wrong guesses exceed the five-try cap.
  const attempt = await dc.env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1, used_at = CASE WHEN code_hash = ? THEN ? ELSE used_at END WHERE id = ? AND used_at IS NULL AND attempts < 5 AND expires_at > ? RETURNING code_hash")
    .bind(hash, Date.now(), challenge.id, Date.now()).first<{ code_hash: string }>();
  if (!attempt || attempt.code_hash !== hash || !/^\d{6}$/.test(code)) throw invalid();
  const active = await activeMember(dc, member.id);
  if (!active) throw invalid();
  return issueSession(dc, active, request, "email_code");
}
