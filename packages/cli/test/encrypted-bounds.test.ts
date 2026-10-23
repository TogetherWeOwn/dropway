/**
 * Local pre-publish regressions at the public encryptFiles boundary. Real crypto,
 * in-memory SourceFile inputs, no filesystem forest or product test seams.
 * Missing count/encoded-size validation must fail; blanket refusal must also fail.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/client.ts";
import { encryptFiles } from "../src/encrypt.ts";
import type { SourceFile } from "../src/publish.ts";

const MiB = 1024 * 1024;
const transportLimit = 24 * MiB;

function source(path: string, bytes: Uint8Array): SourceFile {
  return {
    path, size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    body: async () => bytes,
  };
}

function manyFiles(count: number): SourceFile[] {
  const bytes = new Uint8Array([42]);
  const template = source("index.html", bytes);
  return Array.from({ length: count }, (_, i) => ({
    ...template, path: i === 0 ? "index.html" : `assets/file-${i}.bin`,
  }));
}

/** Valid multi-directory paths; no overlong (>255 byte) filesystem component. */
function largeContainer(segmentLength: number): SourceFile[] {
  const template = source("index.html", new Uint8Array(1677).fill(65));
  const directory = ["a", "b", "c"].map(letter => letter.repeat(segmentLength)).join("/");
  return Array.from({ length: 10_000 }, (_, i) => ({
    ...template, path: i === 0 ? "index.html" : `${directory}/file-${i}.bin`,
  }));
}

async function refusal(files: SourceFile[]): Promise<CliError> {
  let caught: unknown;
  let publishedBytes: number | undefined;
  try {
    const result = await encryptFiles(files);
    publishedBytes = result.files.reduce((sum, file) => sum + file.size, 0);
  } catch (error) { caught = error; }
  expect(caught !== undefined, `expected local refusal, but encryption succeeded with ${publishedBytes} upload bytes`).toBe(true);
  // Don't let a resolved result dump generated fragment keys or giant payloads
  // into a failing assertion. Successful encryption here is the bug, not a pass.
  expect(caught instanceof CliError, "encryptFiles must reject locally with a CliError before its output can be published").toBe(true);
  const error = caught as CliError;
  expect(error.code).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(error.exitCode).toBe(6);
  expect(error.retryable).toBe(false);
  expect(error.status, "a local refusal must not depend on an HTTP failure").toBeUndefined();
  expect(error.hint, "tell the caller how to reduce the encrypted input").toMatch(/smaller|reduce|fewer|remove|split|limit/i);
  return error;
}

async function accepted(files: SourceFile[]) {
  const encrypted = await encryptFiles(files);
  expect(encrypted.fragment.length > 1, "successful encryption must retain a share key").toBe(true);
  expect(encrypted.files.length).toBeGreaterThan(0);
  let total = 0;
  for (const file of encrypted.files) {
    const body = await file.body();
    const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;
    expect(bytes.byteLength).toBe(file.size);
    expect(createHash("sha256").update(bytes).digest("hex") === file.sha256, "encrypted upload hash must match its real bytes").toBe(true);
    total += bytes.byteLength;
  }
  expect(total, "accepted encrypted output must fit the loader's 24 MiB transport bound").toBeLessThanOrEqual(transportLimit);
  console.info("Accepted encrypted control:", JSON.stringify({ sourceFiles: files.length, rawBytes: files.reduce((sum, file) => sum + file.size, 0), transportBytes: total }));
  return total;
}

describe("encrypted container local bounds before publish", () => {
  it("rejects 10001 tiny source files with a stable actionable file-count error", async () => {
    const files = manyFiles(10_001);
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBeLessThan(16 * MiB);
    const first = await refusal(files);
    expect(first.message).toMatch(/files|file.count/i);
    expect(first.message + " " + first.hint).toMatch(/10[,_ ]?000|fewer|reduce|limit/i);
    const second = await refusal(files);
    expect(second.code).toBe(first.code);
  });

  it("accepts exactly 10000 tiny source files rather than refusing the boundary", async () => {
    await accepted(manyFiles(10_000));
  });

  it("rejects base64/JSON transport overflow despite at most 10000 files and 16 MiB raw source", async () => {
    const files = largeContainer(120);
    expect(files).toHaveLength(10_000);
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(16 * MiB);
    // A schema-independent lower bound: just base64 bodies + original path
    // bytes exceed 24 MiB, even before JSON syntax, IV and GCM tag overhead.
    const minimumEncodedBytes = files.reduce((sum, file) => sum + 4 * Math.ceil(file.size / 3) + Buffer.byteLength(file.path), 0);
    expect(minimumEncodedBytes).toBeGreaterThan(transportLimit);
    const first = await refusal(files);
    expect(first.message + " " + first.hint).toMatch(/container|encod|transport|encrypt/i);
    expect(first.message + " " + first.hint).toMatch(/24|large|size|limit/i);
    const second = await refusal(files);
    expect(second.code).toBe(first.code);
  });

  it("accepts the same raw bytes and file count with paths that keep the encoded output near but below 24 MiB", async () => {
    const files = largeContainer(60);
    expect(files).toHaveLength(10_000);
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBe(16_770_000);
    const total = await accepted(files);
    expect(total, "the control must exercise a genuinely near-boundary encoded container").toBeGreaterThan(23 * MiB);
  });
});
