import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { unstable_startWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
let work: string;
let api: string;
let key: string;

beforeAll(async () => {
  work = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "dropway-transfer-cli-"));
  const persist = join(work, "state");
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL("bin/wrangler.js", import.meta.resolve("wrangler/package.json"))), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  worker = await unstable_startWorker({
    config: join(root, "wrangler.jsonc"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist, watch: false, logLevel: "error" },
    bindings: {
      ADMIN_BOOTSTRAP_KEY: { type: "plain_text", value: "transfer-cli-bootstrap-sample-only" },
      SITES_MODE: { type: "plain_text", value: "subdomain" },
      SITES_DOMAIN: { type: "plain_text", value: "deliveries.example" },
    },
  });
  await worker.ready;
  api = (await worker.url).origin;
  const setup = await fetch(`${api}/api/v1/setup`, {
    method: "POST", headers: { Authorization: "Bearer transfer-cli-bootstrap-sample-only", "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cli-sender@example.net" }),
  });
  expect(setup.status).toBe(201);
  key = (await setup.json() as { apiKey: { key: string } }).apiKey.key;
}, 120_000);

afterAll(async () => {
  await worker?.dispose();
  if (work) await rm(work, { recursive: true, force: true });
});

async function cli(operation: string | string[], data?: Record<string, unknown>) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (text) => void (stdout += text), stderr: (text) => void (stderr += text),
    stdinIsTTY: false, stderrIsTTY: false, readStdin: async () => "",
    prompt: async () => { throw new Error("transfer commands must not prompt in non-TTY mode"); },
    env: { DROPWAY_CONFIG_DIR: join(work, "credentials"), DROPWAY_API: api }, cwd: work,
  };
  const command = typeof operation === "string" ? [operation] : operation;
  const payload = data === undefined ? [] : ["--data", JSON.stringify(data)];
  const code = await run(["api", ...command, ...payload, "--key", key, "--json"], io);
  return { code, stdout, stderr, body: stdout ? JSON.parse(stdout) : null };
}

const delivery = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, files: [{ path: "brief.txt", content: "CLI delivery sample", contentType: "text/plain" }],
  recipients: [" CLI-READER@EXAMPLE.NET ", "cli-reader@example.net"], expiresAt: Date.now() + 7_200_000,
  ...extra,
});

describe("transfer CLI through the real registry and local Worker", () => {
  it("keeps slashless raw paths working alongside operation-ID dispatch", async () => {
    const created = await cli("create_transfer", delivery("cli-raw-path-parcel"));
    expect(created.code, created.stdout + created.stderr).toBe(0);
    for (const path of ["sites", "/sites"]) {
      const listed = await cli(["GET", path]);
      expect(listed.code, listed.stdout + listed.stderr).toBe(0);
      expect(listed.body.sites.map((s: { slug: string }) => s.slug)).toContain("cli-raw-path-parcel");
    }
  });

  it("creates by operation ID, reads the transfer and revokes it with machine-readable results", async () => {
    const created = await cli("create_transfer", delivery("cli-parcel"));
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const t = created.body.transfer ?? created.body;
    expect(t.id).toEqual(expect.any(String));
    expect(t.mode).toBe("transfer");
    expect(t.recipients.map((r: { email: string }) => r.email)).toEqual(["cli-reader@example.net"]);
    expect(new URL(t.url).origin).toBe(api);
    const read = await cli("get_transfer", { transfer: t.id });
    expect(read.code, read.stdout + read.stderr).toBe(0);
    expect((read.body.transfer ?? read.body).id).toBe(t.id);
    const revoked = await cli("revoke_transfers", { ids: [t.id] });
    expect(revoked.code, revoked.stdout + revoked.stderr).toBe(0);
    expect(revoked.body.count).toBe(1);
    const ownerRead = await cli("get_transfer", { transfer: t.id });
    expect(ownerRead.code).toBe(0);
  });

  it("returns a nonzero exit and a structured refusal for an invalid password", async () => {
    const r = await cli("create_transfer", delivery("cli-refusal", { password: "short" }));
    expect(r.code).not.toBe(0);
    expect(r.body.error.code).toMatch(/^[a-z][a-z0-9_]+$/);
    expect(r.body.error.hint.length).toBeGreaterThan(0);
    expect(r.body.error.code).not.toMatch(/unknown_(?:command|operation)|invalid_method|route_not_found|network_error/);
  });
});
