import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only bindings: migrations to apply, and a known bootstrap secret.
          TEST_MIGRATIONS: await readD1Migrations(`${root}packages/core/migrations`),
          ADMIN_BOOTSTRAP_KEY: "test-bootstrap-secret-0123456789",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for a cold Workers runtime start.
    testTimeout: 30_000,
  },
});
