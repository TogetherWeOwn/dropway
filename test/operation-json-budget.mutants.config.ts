import { mergeConfig } from "vitest/config";
import baseline from "../vitest.config.ts";

// Isolated, in-memory guard deletion; never writes a production file. This
// anchor belongs to reviewed head 1a55f581ee37ed6b4f7fc93a3a74875d2649e29e.
// npx vitest run -c test/operation-json-budget.mutants.config.ts
// Expected: 14 rejection failures and four passing valid-budget controls.
const guard = [
  "  if (definition.jsonBodyMaxBytes !== undefined && (!Number.isSafeInteger(definition.jsonBodyMaxBytes) || definition.jsonBodyMaxBytes <= 0)) {",
  "    throw new Error(`Invalid JSON body byte limit: ${definition.id}`);",
  "  }",
].join("\n");

const config = mergeConfig(baseline, {
  plugins: [{
    name: "json-byte-budget-guard-deletion",
    enforce: "pre",
    transform(source: string, id: string) {
      if (!id.replaceAll("\\", "/").split("?")[0]!.endsWith("/packages/server/src/operations.ts")) return;
      const matches = source.split(guard).length - 1;
      if (matches !== 1) throw new Error(`JSON byte budget mutant: expected one guard anchor, found ${matches}.`);
      console.info("Applied JSON byte budget mutant: deleted definition/registration validation guard");
      return { code: source.replace(guard, "  /* isolated test mutant: omit JSON byte budget validation */"), map: null };
    },
  }],
});

// mergeConfig concatenates arrays; replace include to isolate this proof.
export default {
  ...config,
  test: { ...config.test, include: ["test/operation-json-budget-validation.test.ts"] },
};
