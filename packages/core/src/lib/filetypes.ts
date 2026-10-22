import { baseType, extname, isHtml, isMarkdown } from "./mime";

/**
 * What kind of thing a stored file is, for choosing a viewer.
 * The serving layer (packages/server/src/viewers) maps kinds to renderers;
 * keep this list stable and add kinds rather than renaming them.
 */
export type FileKind =
  | "html"
  | "markdown"
  | "image"
  | "svg"
  | "pdf"
  | "video"
  | "audio"
  | "json"
  | "csv"
  | "code"
  | "text"
  | "notebook"
  | "model3d"
  | "font"
  | "archive"
  | "wasm"
  | "binary";

const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  css: "css", scss: "scss", less: "less", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", sql: "sql", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", xml: "xml", graphql: "graphql", gql: "graphql", lua: "lua", r: "r",
  dart: "dart", scala: "scala", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", vue: "vue",
  svelte: "svelte", dockerfile: "dockerfile", makefile: "makefile", zig: "zig", nim: "nim", tf: "hcl",
};

/** Syntax-highlighting language id for a path, or null. */
export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return CODE_LANGUAGES[extname(path)] ?? null;
}

export function detectFileKind(path: string, contentType: string): FileKind {
  const t = baseType(contentType);
  const ext = extname(path);
  if (isHtml(contentType)) return "html";
  if (isMarkdown(path, contentType)) return "markdown";
  if (t === "image/svg+xml") return "svg";
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (ext === "ipynb" || t === "application/x-ipynb+json") return "notebook";
  if (t === "application/json" || t === "application/ld+json" || t === "application/manifest+json" || ext === "json") return "json";
  if (t === "text/csv" || t === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "csv";
  if (t.startsWith("model/") || ext === "glb" || ext === "gltf" || ext === "usdz") return "model3d";
  if (t.startsWith("font/") || ["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) return "font";
  if (t === "application/wasm" || ext === "wasm") return "wasm";
  if (["zip", "tar", "gz", "tgz", "br", "7z", "rar"].includes(ext)) return "archive";
  if (languageFor(path)) return "code";
  if (t.startsWith("text/") || t === "application/xml") return "text";
  return "binary";
}
