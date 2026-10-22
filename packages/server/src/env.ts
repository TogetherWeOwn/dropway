import type { CoreBindings, DropwayContext, DropwayVars, Principal } from "@dropway/core";

/** Bindings + vars the Worker receives. Extensions may add their own bindings. */
export type ServerBindings = CoreBindings & DropwayVars & Record<string, unknown>;

/** Hono environment shared by every Dropway route (core and extension routes). */
export type DropwayEnv = {
  Bindings: ServerBindings;
  Variables: {
    /** Per-request service context: pass it to any @dropway/core service. */
    dw: DropwayContext;
    /** The authenticated caller (resolved by the identity adapter for /api/* routes). */
    principal: Principal;
    requestId: string;
  };
};
