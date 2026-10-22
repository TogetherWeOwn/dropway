#!/usr/bin/env node
// Launcher for the `dropway` CLI.
// - Published package: runs the bundle dist/dropway.mjs (built on `npm pack` / `npm publish`).
// - Working copy: runs src/cli.ts directly when Node can strip TypeScript types (22.18+ / 23.6+),
//   so a stale dist/ never shadows the source; otherwise falls back to dist/.
import { existsSync } from "node:fs";

const src = new URL("../src/cli.ts", import.meta.url);
const dist = new URL("../dist/dropway.mjs", import.meta.url);

if (existsSync(src) && process.features?.typescript) {
  await import(src.href);
} else if (existsSync(dist)) {
  await import(dist.href);
} else {
  console.error("dropway: this working copy is not built. Run `npm run build -w dropway`, or use Node 22.18+.");
  process.exit(1);
}
