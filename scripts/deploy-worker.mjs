import { execFileSync, spawnSync } from "node:child_process";

// Workers Builds supplies the commit; command-line deploys use the local checkout.
const sha = (process.env.WORKERS_CI_COMMIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Deployment requires a full commit SHA (WORKERS_CI_COMMIT_SHA or git HEAD).");
const result = spawnSync("wrangler", ["deploy", "--var", `BUILD_SHA:${sha}`], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
