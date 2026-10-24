/** Request queries may contain credentials, including parameters unknown to core. */
export function diagnosticText(value: unknown): string {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.split(/[?#]/, 1)[0]!)
    .replace(/\b(?:dwl|dws|dwc|dw)_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 8000);
}
