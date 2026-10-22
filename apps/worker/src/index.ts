/**
 * The open-source, single-tenant Dropway Worker.
 *
 * One tenant (an owner plus optional members and scoped API keys), no signup,
 * no plans or billing. Configuration comes from wrangler.jsonc vars and secrets.
 * To build on top of Dropway, call createDropway() with your own adapters,
 * hooks, routes, MCP tools and UI slots instead of editing the packages.
 */
import { createDropway, type ServerBindings } from "@dropway/server";

const dropway = createDropway();

export default {
  fetch: dropway.fetch,
  scheduled: dropway.scheduled,
} satisfies ExportedHandler<ServerBindings>;
