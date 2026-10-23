/** Raw input/path refusal belongs before encryption or any publishing side effect. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/client.ts";
import { encryptFiles } from "../src/encrypt.ts";
import type { SourceFile } from "../src/publish.ts";

const rawLimit = 16 * 1024 * 1024;

function source(path: string, bytes = new Uint8Array([42])): SourceFile {
  return { path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), body: async () => bytes };
}

async function capture(files: SourceFile[]) {
  try { await encryptFiles(files); return undefined; } catch (error) { return error; }
}

function localRefusal(error: unknown, code: string) {
  // Never compare an encryptFiles result: it contains a generated fragment key.
  expect(error instanceof CliError, "expected a local CliError, not successful encryption or a reader exception").toBe(true);
  const refusal = error as CliError;
  expect(refusal.code).toBe(code);
  expect(refusal.exitCode).toBe(6);
  expect(refusal.status).toBeUndefined();
  expect(refusal.retryable).toBe(false);
  expect(refusal.hint).toMatch(code === "encrypted_invalid_path" ? /rename|remove/i : /smaller|reduce|remove|split|limit/i);
}

describe("encrypted raw-byte limits (separate from the 24 MiB encoded limit)", () => {
  it("accepts exactly 16 MiB of ordinary Uint8Array source bytes", async () => {
    const result = await encryptFiles([source("index.html", new Uint8Array(rawLimit))]);
    expect(result.fragment.length > 1, "accepted input needs a fragment key").toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(24 * 1024 * 1024);
  });

  it.each(["single file", "aggregate"])("preflights known oversized %s metadata without calling ANY body reader", async kind => {
    let reads = 0;
    const lazy = (path: string, size: number): SourceFile => ({
      ...source(path), size, body: async () => { reads++; return new Uint8Array([42]); },
    });
    const files = kind === "single file"
      ? [lazy("index.html", rawLimit + 1)]
      : [lazy("index.html", rawLimit / 2), lazy("asset.bin", rawLimit / 2 + 1)];
    const error = await capture(files);
    expect(reads, "known oversized metadata must be rejected before even the first body read").toBe(0);
    localRefusal(error, "encrypted_input_too_large");
  });

  it("rejects exactly 16 MiB + 1 actual Uint8Array bytes even if SourceFile.size lies", async () => {
    const file = { ...source("index.html", new Uint8Array(rawLimit + 1)), size: 1 };
    localRefusal(await capture([file]), "encrypted_input_too_large");
  });

  it("rejects a Blob with 16 MiB + 1 real bytes despite a one-byte SourceFile size", async () => {
    const blob = new Blob([new Uint8Array(rawLimit + 1)]);
    const file = { ...source("index.html"), size: 1, body: async () => blob };
    localRefusal(await capture([file]), "encrypted_input_too_large");
  });

  it("cancels a lying Blob stream at remaining capacity instead of eagerly calling arrayBuffer", async () => {
    let arrayBuffers = 0;
    let pulls = 0;
    let cancelled = false;
    // The real backing bytes are three bytes; neither size field admits that.
    // Two bytes remain after the first file. Chunk 2 crosses that remainder.
    class LyingBlob extends Blob {
      override readonly size = 1;
      override async arrayBuffer() { arrayBuffers++; return super.arrayBuffer(); }
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          pull(controller) {
            pulls++;
            if (pulls === 1) controller.enqueue(new Uint8Array([1]));
            else if (pulls === 2) controller.enqueue(new Uint8Array([2, 3]));
            else controller.close();
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 });
      }
    }
    const file = { ...source("asset.bin"), size: 1, body: async () => new LyingBlob([new Uint8Array([1, 2, 3])]) };
    const error = await capture([source("index.html", new Uint8Array(rawLimit - 2)), file]);
    expect(arrayBuffers, "Blob.arrayBuffer would allocate the full untrusted input before the guard").toBe(0);
    expect(cancelled, "crossing the remaining raw capacity must cancel the source reader").toBe(true);
    expect(pulls, "do not drain an already oversized stream").toBe(2);
    localRefusal(error, "encrypted_input_too_large");
  });

  it("accepts a Blob stream exactly filling the remaining raw capacity", async () => {
    let arrays = 0;
    let streams = 0;
    class ObservedBlob extends Blob {
      override async arrayBuffer() { arrays++; return super.arrayBuffer(); }
      override stream() { streams++; return super.stream(); }
    }
    const result = await encryptFiles([
      source("index.html", new Uint8Array(rawLimit - 3)),
      { ...source("asset.bin"), size: 3, body: async () => new ObservedBlob([new Uint8Array([1, 2, 3])]) },
    ]);
    expect(result.fragment.length > 1).toBe(true);
    expect(arrays, "even accepted Blobs must use the bounded streaming reader").toBe(0);
    expect(streams).toBe(1);
  });
});

describe("encrypted paths must satisfy the loader contract without normalization", () => {
  const invalid = [
    "assets\\bad.txt", "/root.txt", "", ".", "..", "./asset.txt", "../asset.txt",
    "assets/./bad.txt", "assets/../bad.txt", "assets//bad.txt", "assets/",
    ...Array.from({ length: 32 }, (_, code) => `assets/control-${String.fromCharCode(code)}.txt`),
  ];
  it.each(invalid.map((path, index) => [index, path] as const))("rejects loader-invalid path case %i before producing publishable bytes", async (_index, path) => {
    localRefusal(await capture([source("index.html"), source(path)]), "encrypted_invalid_path");
  });

  it("rejects duplicate packed paths rather than silently shadowing one file", async () => {
    localRefusal(await capture([source("index.html"), source("index.html", new Uint8Array([43]))]), "encrypted_invalid_path");
  });

  it("accepts Unicode, spaces and punctuation without imposing an ASCII filename policy", async () => {
    const result = await encryptFiles([source("index.html"), source("assets/你好 café + (v1)! &@.txt")]);
    expect(result.fragment.length > 1).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });
});
