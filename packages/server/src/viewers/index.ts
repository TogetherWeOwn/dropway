import { detectFileKind, type DropwayContext, type FileKind, type LiveSite } from "@dropway/core";
import { markdownViewer } from "./markdown";

/**
 * Viewers turn a stored file into a rendered page when a person opens it in a
 * browser. They never run for sub-resource requests (fetch, <img>, <script>):
 * those always get the raw bytes, so sites keep working. `?raw=1` always
 * returns the raw bytes; `?view=1` forces the viewer.
 *
 * To add a viewer (images, PDF, CSV, JSON, code, notebooks, ...): create a file
 * in this folder exporting a Viewer, then add it to VIEWERS below. Match on
 * file.kind (from @dropway/core detectFileKind). The first match wins.
 */
export interface ViewerFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  kind: FileKind;
}

export interface ViewerContext {
  dw: DropwayContext;
  request: Request;
  url: URL;
  live: LiveSite;
  file: ViewerFile;
  /** URL of the raw bytes (same path + ?raw=1). */
  rawUrl: string;
  /** URL that downloads the file (same path + ?download=1). */
  downloadUrl: string;
  /** Read the file as UTF-8 text (only call when file.size <= viewer.maxBytes). */
  readText(): Promise<string>;
}

export interface Viewer {
  id: string;
  /** Files larger than this are served raw instead. */
  maxBytes: number;
  matches(file: ViewerFile, live: LiveSite): boolean;
  /** Return the full response (an HTML page). Headers such as CSP are added by the caller if absent. */
  render(vc: ViewerContext): Promise<Response>;
}

export const VIEWERS: Viewer[] = [markdownViewer];

export function toViewerFile(path: string, sha256: string, size: number, contentType: string): ViewerFile {
  return { path, sha256, size, contentType, kind: detectFileKind(path, contentType) };
}

export function findViewer(file: ViewerFile, live: LiveSite, viewers: readonly Viewer[] = VIEWERS): Viewer | null {
  for (const v of viewers) if (file.size <= v.maxBytes && v.matches(file, live)) return v;
  return null;
}

/** CSP for viewer pages: no scripts, so user-authored markup inside e.g. Markdown cannot execute. */
export const VIEWER_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' https:; font-src * data:; frame-src https:; base-uri 'none'; form-action 'none'";
