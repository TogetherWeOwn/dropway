import { mergeConfig } from "vitest/config";
import baseline from "../vitest.config.ts";

// Test-only, in-memory mutations of the reviewed baseline. No production file is
// ever written. Fail closed if an anchor changes, so a skipped mutation cannot
// masquerade as coverage. This runner is intentionally tied to the reviewed SHA.
//
// OPERATION_REVIEW_MUTANT=guard npx vitest run -c test/operation-review.mutants.config.ts -t 'private guard'
// OPERATION_REVIEW_MUTANT=url npx vitest run -c test/operation-review.mutants.config.ts -t 'URL wins'
// OPERATION_REVIEW_MUTANT=output npx vitest run -c test/operation-review.mutants.config.ts -t 'invalid output'
const mutations = {
  guard: {
    before: 'if ((ctx.principal.kind === "anonymous" || ctx.principal.kind === "bootstrap") && !op.anonymous) requireMember(ctx.principal);',
    after: "/* isolated test mutant: omit private authentication guard */",
  },
  url: {
    before: "return { ...query, ...body, ...c.req.param() };",
    after: "return { ...query, ...c.req.param(), ...body };",
  },
  output: {
    before: "const output = op.output.safeParse(result);",
    after: "const output = { success: true, data: result };",
  },
};
const name = process.env.OPERATION_REVIEW_MUTANT;
if (!name || !(name in mutations)) throw new Error("Select OPERATION_REVIEW_MUTANT=guard|url|output.");
const mutation = mutations[name as keyof typeof mutations];

const config = mergeConfig(baseline, {
  plugins: [{
    name: "operation-review-isolated-mutant",
    enforce: "pre",
    transform(source: string, id: string) {
      if (!id.replaceAll("\\", "/").split("?")[0]!.endsWith("/packages/server/src/operations.ts")) return;
      const matches = source.split(mutation.before).length - 1;
      if (matches !== 1) throw new Error(`Mutant ${name}: expected one baseline anchor, found ${matches}.`);
      console.info(`Applied operation review mutant: ${name}`);
      return { code: source.replace(mutation.before, mutation.after), map: null };
    },
  }],
});
// mergeConfig concatenates arrays; replace include instead of importing every test.
export default {
  ...config,
  test: { ...config.test, include: ["test/operation-review-transport.test.ts"] },
};
