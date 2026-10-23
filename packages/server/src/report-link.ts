import { escapeHtml } from "./html";

/** Part of transformed HTML ETags; bump when the injected markup changes. */
export const REPORT_LINK_VERSION = 1;

/** The destination is absolute: publishers can supply an untrusted <base>. */
export function injectReportLink(response: Response, destination: string): Response {
  const link = `<a href="${escapeHtml(destination)}" target="_blank" rel="noopener noreferrer" style="position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;color:#333;font:12px/1.4 system-ui,sans-serif;text-decoration:underline">Report abuse</a>`;
  // Document-end also runs for fragments without an explicit <body>.
  return new HTMLRewriter().onDocument({ end(end) { end.append(link, { html: true }); } }).transform(response);
}
