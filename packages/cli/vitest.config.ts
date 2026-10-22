import { defineConfig } from "vitest/config";

// Node-side CLI tests (argument parsing, ignore rules, file walking, credentials,
// the built binary). The publish protocol itself is tested against the real
// Worker in /test/cli-publish.test.ts, inside the Workers runtime.
export default defineConfig({
  test: {
    name: "cli",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
