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

/** Kinds stored as UTF-8 text, so a "source" view makes sense for them. */
export const TEXT_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(["html", "markdown", "svg", "json", "csv", "code", "text", "notebook"]);

/** Short human label for a kind (viewer bars, dashboard file lists). */
export const KIND_LABELS: Record<FileKind, string> = {
  html: "HTML page",
  markdown: "Markdown",
  image: "Image",
  svg: "SVG image",
  pdf: "PDF document",
  video: "Video",
  audio: "Audio",
  json: "JSON",
  csv: "Table",
  code: "Code",
  text: "Text",
  notebook: "Jupyter notebook",
  model3d: "3D model",
  font: "Font",
  archive: "Archive",
  wasm: "WebAssembly",
  binary: "Binary file",
};

/**
 * Extension -> syntax-highlighting language id. The ids are highlight.js names
 * (the server maps the few it lacks, such as "vue" or "hcl", to a close one).
 */
const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  mts: "typescript", cts: "typescript",
  css: "css", scss: "scss", sass: "scss", less: "less", styl: "stylus",
  py: "python", pyi: "python", pyw: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", kts: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", fs: "fsharp", fsx: "fsharp", m: "objectivec", mm: "objectivec",
  php: "php", pl: "perl", pm: "perl", sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell", psm1: "powershell",
  bat: "dos", cmd: "dos",
  sql: "sql", psql: "pgsql", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
  env: "bash", xml: "xml", xsd: "xml", xsl: "xml", plist: "xml", rss: "xml", atom: "xml",
  graphql: "graphql", gql: "graphql", proto: "protobuf", thrift: "thrift",
  lua: "lua", r: "r", dart: "dart", scala: "scala", sc: "scala", groovy: "groovy", gradle: "gradle",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang", hs: "haskell", elm: "elm", ml: "ocaml", mli: "ocaml",
  clj: "clojure", cljs: "clojure", edn: "clojure", jl: "julia", nim: "nim", nix: "nix", zig: "zig", v: "verilog", sv: "verilog",
  vhd: "vhdl", vue: "vue", svelte: "svelte", astro: "xml", hbs: "handlebars", handlebars: "handlebars", twig: "twig",
  erb: "erb", ejs: "xml", tf: "hcl", tfvars: "hcl", hcl: "hcl", cmake: "cmake", mk: "makefile",
  diff: "diff", patch: "diff", tex: "latex", sty: "latex", bib: "latex", asm: "x86asm", s: "x86asm", wat: "wasm",
  vim: "vim", glsl: "glsl", frag: "glsl", vert: "glsl", wgsl: "rust", sol: "javascript", prisma: "graphql",
  http: "http", rest: "http", nginx: "nginx", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json",
  mmd: "mermaid", mermaid: "mermaid", ipynb: "json", vb: "vbnet", vbs: "vbscript", coffee: "coffeescript",
  cr: "crystal", d: "d", pas: "delphi", f90: "fortran", f: "fortran", lisp: "lisp", scm: "scheme", rkt: "scheme",
  tcl: "tcl", awk: "awk", sed: "bash",
};

/** Files without an extension that are code or config, keyed by lowercase basename. */
const CODE_BASENAMES: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile",
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby", brewfile: "ruby", vagrantfile: "ruby", jenkinsfile: "groovy",
  "cmakelists.txt": "cmake", ".gitignore": "bash", ".dockerignore": "bash", ".gitattributes": "bash", ".npmrc": "ini",
  ".editorconfig": "ini", ".env": "bash", ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash", procfile: "yaml",
  "nginx.conf": "nginx", caddyfile: "nginx", justfile: "makefile",
};

/** Well-known plain-text files without an extension. */
const TEXT_BASENAMES = new Set(["license", "licence", "readme", "changelog", "changes", "authors", "contributors", "notice", "copying", "codeowners", "todo", "version"]);

/** Syntax-highlighting language id for a path, or null. */
export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (CODE_BASENAMES[base]) return CODE_BASENAMES[base]!;
  if (base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "dockerfile";
  if (base.startsWith(".env.")) return "bash";
  return CODE_LANGUAGES[extname(path)] ?? null;
}

export function detectFileKind(path: string, contentType: string): FileKind {
  const t = baseType(contentType);
  const ext = extname(path);
  if (isHtml(contentType)) return "html";
  if (isMarkdown(path, contentType)) return "markdown";
  if (t === "image/svg+xml" || ext === "svg") return "svg";
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  if (t.startsWith("video/") && ext !== "ts") return "video";
  if (t.startsWith("audio/")) return "audio";
  if (ext === "ipynb" || t === "application/x-ipynb+json") return "notebook";
  if (
    t === "application/json" ||
    t === "application/ld+json" ||
    t === "application/manifest+json" ||
    t === "application/geo+json" ||
    ext === "json" ||
    ext === "geojson" ||
    ext === "webmanifest"
  ) {
    return "json";
  }
  if (t === "text/csv" || t === "text/tab-separated-values" || ext === "csv" || ext === "tsv") return "csv";
  if (t.startsWith("model/") || ext === "glb" || ext === "gltf" || ext === "usdz") return "model3d";
  if (t.startsWith("font/") || ["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) return "font";
  if (t === "application/wasm" || ext === "wasm") return "wasm";
  if (["zip", "tar", "gz", "tgz", "br", "7z", "rar", "bz2", "xz", "zst"].includes(ext)) return "archive";
  if (languageFor(path)) return "code";
  if (t.startsWith("text/") || t === "application/xml") return "text";
  if (TEXT_BASENAMES.has(path.slice(path.lastIndexOf("/") + 1).toLowerCase())) return "text";
  return "binary";
}
