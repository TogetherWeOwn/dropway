import type { DeleteEvent, DropwayHooks, PublishEvent, SiteRequestEvent, UsageEvent } from "../adapters";
import type { DropwayContext } from "../context";

type HookName = keyof DropwayHooks;
type HookEvent<K extends HookName> = K extends "onPublish" ? PublishEvent : K extends "onDelete" ? DeleteEvent : SiteRequestEvent;

function logFailure(what: string, e: unknown) {
  console.error(JSON.stringify({ event: "extension_error", what, error: String(e), stack: (e as Error)?.stack }));
}

/** Run every registered hook for an event after the response (never throws). */
export function emit<K extends HookName>(dc: DropwayContext, name: K, event: HookEvent<K>): void {
  for (const hooks of dc.hooks) {
    const fn = hooks[name] as ((e: HookEvent<K>, dc: DropwayContext) => void | Promise<void>) | undefined;
    if (!fn) continue;
    try {
      const r = fn(event, dc);
      if (r && typeof (r as Promise<void>).then === "function") dc.waitUntil((r as Promise<void>).catch((e) => logFailure(name, e)));
    } catch (e) {
      logFailure(name, e);
    }
  }
}

/** Record a usage event with the metering adapter after the response (never throws). */
export function meter(dc: DropwayContext, event: UsageEvent): void {
  try {
    const r = dc.adapters.metering.record(event, dc);
    if (r && typeof (r as Promise<void>).then === "function") dc.waitUntil((r as Promise<void>).catch((e) => logFailure("metering", e)));
  } catch (e) {
    logFailure("metering", e);
  }
}
