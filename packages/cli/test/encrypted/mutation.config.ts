/**
 * Optional negative controls, not the normal test command:
 * KOFRA_ENCRYPTED_MUTANT=constant-key|spa-guard|wait-url|loader-cap \
 *   node_modules/.bin/vitest run -c packages/cli/test/encrypted/mutation.config.ts \
 *   test/encrypted/acceptance.test.ts -t 'fresh keys|SPA refusal|encrypted wait|loader stream cap'
 * Run one mutant and its corresponding test at a time. Every run must fail its
 * behavioral assertion, never fail to initialize. No repository source writes.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.ts";

const mutant = process.env.KOFRA_ENCRYPTED_MUTANT;
const mutations = {
  "constant-key": { path: "/packages/cli/src/encrypt.ts", before: "const rawKey = randomBytes(32);", after: "const rawKey = Buffer.alloc(32, 7);" },
  "spa-guard": { path: "/packages/cli/src/main.ts", before: 'if (encrypt && bool(p, "spa"))', after: 'if (false && encrypt && bool(p, "spa"))' },
  "wait-url": { path: "/packages/cli/src/main.ts", before: "waitUrl ?? result.url", after: "result.url" },
} as const;
if (!mutant || ![...Object.keys(mutations), "loader-cap"].includes(mutant)) throw Error("select one documented encrypted acceptance mutant");

export default mergeConfig(base, defineConfig({
  plugins: [{
    name: "encrypted-acceptance-negative-controls", enforce: "pre",
    transform(source, id) {
      const change = mutations[mutant as keyof typeof mutations];
      if (!change || !id.split("?")[0]!.endsWith(change.path)) return;
      if (source.split(change.before).length !== 2) throw Error(`${mutant} mutant requires exactly one matching expression`);
      return { code: source.replace(change.before, change.after), map: null };
    },
  }],
}));
