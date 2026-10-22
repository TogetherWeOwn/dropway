const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  json: "application/json",
  jsonld: "application/ld+json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  geojson: "application/geo+json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  diff: "text/x-diff",
  patch: "text/x-diff",
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "application/xml",
  rss: "application/rss+xml",
  atom: "application/atom+xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  ini: "text/plain",
  sh: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  kt: "text/plain",
  swift: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  cs: "text/plain",
  php: "text/plain",
  sql: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  pdf: "application/pdf",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  vtt: "text/vtt",
  srt: "text/plain",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  br: "application/x-brotli",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  usdz: "model/vnd.usdz+zip",
  data: "application/octet-stream",
  bin: "application/octet-stream",
  unityweb: "application/octet-stream",
  pck: "application/octet-stream",
  ipynb: "application/x-ipynb+json",
};

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function contentTypeFor(path: string): string {
  return withCharset(TYPES[extname(path)] ?? "application/octet-stream");
}

export function withCharset(type: string): string {
  if (type.includes("charset=")) return type;
  return isTextual(type) ? `${type}; charset=utf-8` : type;
}

export function baseType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

export function isTextual(contentType: string): boolean {
  const t = baseType(contentType);
  return (
    t.startsWith("text/") ||
    t === "application/json" ||
    t === "application/ld+json" ||
    t === "application/manifest+json" ||
    t === "application/geo+json" ||
    t === "application/x-ndjson" ||
    t === "application/xml" ||
    t === "application/xhtml+xml" ||
    t === "application/rss+xml" ||
    t === "application/atom+xml" ||
    t === "application/javascript" ||
    t === "application/x-ipynb+json" ||
    t === "image/svg+xml" ||
    t === "model/gltf+json"
  );
}

export function isHtml(contentType: string): boolean {
  const t = baseType(contentType);
  return t === "text/html" || t === "application/xhtml+xml";
}

export function isMarkdown(path: string, contentType: string): boolean {
  return baseType(contentType) === "text/markdown" || ["md", "markdown", "mdx"].includes(extname(path));
}

/**
 * Pre-compressed build outputs (Unity/Godot/Emscripten: app.wasm.br, app.js.gz).
 * Returns the encoding and the content type of the underlying file.
 */
export function precompressed(path: string): { encoding: "br" | "gzip"; contentType: string } | null {
  const ext = extname(path);
  if (ext !== "br" && ext !== "gz") return null;
  const inner = path.slice(0, -(ext.length + 1));
  if (!extname(inner)) return null; // plain foo.gz download, not a pre-compressed asset
  return { encoding: ext === "br" ? "br" : "gzip", contentType: contentTypeFor(inner) };
}

/** Normalise a caller-declared content type; fall back to the extension. */
export function normaliseContentType(declared: string | undefined | null, path: string): string {
  const d = (declared ?? "").trim();
  if (!d || d === "application/octet-stream" || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(d)) return contentTypeFor(path);
  // Browsers and curl often guess text/plain for anything; trust the extension when it is more specific.
  if (baseType(d) === "text/plain" && TYPES[extname(path)] && TYPES[extname(path)] !== "text/plain") return contentTypeFor(path);
  return withCharset(d.toLowerCase());
}
