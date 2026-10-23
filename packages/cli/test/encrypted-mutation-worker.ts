/** Test-only in-memory mutation; never edits a product file or loader response. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

export async function workerEntry(root: string, scratch: string): Promise<string> {
  const entry = join(root, "apps/worker/src/index.ts");
  if (process.env.DROPWAY_ENCRYPTED_MUTANT !== "loader-cap") return entry;
  // Build the actual Worker with exactly one negative-control guard mutation.
  // Wrangler still serves the real loader and HTTP CSP from that Worker. Only
  // the generated bundle lives in scratch; repository source stays unchanged.
  const output = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"],
    plugins: [{
      name: "encrypted-loader-cap-negative-control",
      setup(builder) {
        builder.onLoad({ filter: /\/packages\/server\/src\/encrypted\.ts$/ }, async args => {
          const source = await readFile(args.path, "utf8");
          const guard = "if (size > 24 * 1024 * 1024)";
          if (source.split(guard).length !== 2) throw Error("loader-cap mutant requires exactly one matching guard");
          return { contents: source.replace(guard, "if (false)"), loader: "ts" };
        });
      },
    }],
  });
  if (output.outputFiles.length !== 1) throw Error("expected a single test Worker bundle");
  const path = join(scratch, "worker-cap-mutant.mjs");
  await writeFile(path, output.outputFiles[0]!.contents);
  return path;
}
