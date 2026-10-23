import { badRequest } from "@dropway/core";

/** Split HTTP lists/parameters without treating quoted separators as syntax. */
function splitField(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === delimiter) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (quoted || escaped) throw invalidAccept();
  parts.push(value.slice(start).trim());
  return parts;
}

function invalidAccept() {
  return badRequest("invalid_accept", "This login request has an unsupported Accept header.", "Open the login link directly in a supported browser.");
}

/** Browser evidence restricts issuance; its absence is not browser attestation. */
export function loginNeedsConfirmation(headers: Headers): boolean {
  let html = false;
  const accept = headers.get("Accept");
  if (accept !== null) {
    const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    for (const entry of splitField(accept, ",")) {
      const [media, ...parameters] = splitField(entry, ";");
      const [type, subtype, extra] = media!.split("/");
      if (!type || !subtype || extra !== undefined || !token.test(type) || !token.test(subtype) || (type === "*" && subtype !== "*")) throw invalidAccept();
      let quality = false;
      for (const parameter of parameters) {
        const equals = parameter.indexOf("=");
        const name = parameter.slice(0, equals).trim();
        const value = parameter.slice(equals + 1).trim();
        if (equals < 1 || !token.test(name) || !(token.test(value) || /^"(?:[\t !#-\[\]-~]|\\[\t -~])*"$/.test(value))) throw invalidAccept();
        if (name.toLowerCase() === "q") {
          if (quality || !/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) throw invalidAccept();
          quality = true;
        }
      }
      // Even q=0 is explicit HTML evidence, not permission to consume a link.
      if (["text/html", "application/xhtml+xml"].includes(media!.toLowerCase())) html = true;
    }
  }
  return html || [...headers.keys()].some((name) => name.toLowerCase().startsWith("sec-fetch-"));
}
