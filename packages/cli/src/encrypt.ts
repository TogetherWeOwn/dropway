import { createHash, randomBytes, webcrypto } from "node:crypto";
import { CliError, EXIT } from "./client.ts";
import type { SourceFile } from "./publish.ts";

/** One authenticated container: no source filenames, hashes or bytes reach the instance. */
export async function encryptFiles(files: SourceFile[]): Promise<{ files: SourceFile[]; fragment: string }> {
  if (!files.length) throw new CliError({ code: "no_files", message: "There are no files to encrypt.", hint: "Choose a non-empty file or folder.", exitCode: EXIT.usage });
  const maxBytes = 16 * 1024 * 1024;
  let total = 0;
  const packed: Array<{ path: string; data: string }> = [];
  for (const file of files) {
    const body = await file.body();
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
    total += bytes.byteLength;
    if (total > maxBytes) throw new CliError({ code: "encrypted_input_too_large", message: "Encrypted publishing supports at most 16 MiB of source files.", hint: "Publish a smaller folder; encrypted sites are decrypted entirely in browser memory.", exitCode: EXIT.invalid });
    packed.push({ path: file.path, data: Buffer.from(bytes).toString("base64") });
  }
  const entry = files.find(f => /^index\.html?$/i.test(f.path))?.path ?? files[0]!.path;
  const plaintext = new TextEncoder().encode(JSON.stringify({ format: "dropway-encrypted-v1", entry, files: packed }));
  const rawKey = randomBytes(32);
  const iv = randomBytes(12);
  const key = await webcrypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, plaintext));
  // Versioned magic + 96-bit nonce + ciphertext with its full 128-bit authentication tag.
  const bytes = Buffer.concat([Buffer.from("DWENC001"), iv, ciphertext]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    files: [{ path: "encrypted.bin", size: bytes.byteLength, sha256, body: async () => bytes }],
    fragment: `key=${rawKey.toString("base64url")}`,
  };
}
