import { ORIGIN } from "./r21-helpers";

export const WORKER_APP = "https://dropway.fixture.workers.dev";
export const WORKER_SIBLING = "https://dropway-sites.fixture.workers.dev";

type BrowserCase = { name: string; origin: string; headers: Record<string, string> };

// Each independent failure keeps the other header valid: neither Origin alone,
// Fetch Metadata alone, hostname-only matching, nor Cookie presence is a guard.
export function deniedBrowserHeaders(): BrowserCase[] {
  const cases: Array<Omit<BrowserCase, "origin">> = [
    { name: "both absent", headers: {} },
    { name: "Origin absent independently", headers: { "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin wrong independently", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin opaque independently", headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin same-site sibling independently", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin suffix trick", headers: { Origin: "https://dropway.test.attacker.example", "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin wrong scheme", headers: { Origin: "http://dropway.test", "Sec-Fetch-Site": "same-origin" } },
    { name: "Origin wrong port", headers: { Origin: "https://dropway.test:444", "Sec-Fetch-Site": "same-origin" } },
    { name: "Fetch Metadata absent independently", headers: { Origin: ORIGIN } },
    ...["same-site", "cross-site", "none", "invalid", "Same-Origin"].map((value) => ({
      name: `Fetch Metadata ${value} independently`, headers: { Origin: ORIGIN, "Sec-Fetch-Site": value },
    })),
    { name: "hostile cross-site", headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" } },
    { name: "same-site sibling", headers: { Origin: "https://sites.dropway.test", "Sec-Fetch-Site": "same-site" } },
  ];
  return [
    ...cases.map((entry) => ({ ...entry, origin: ORIGIN })),
    { name: "workers.dev sibling independently", origin: WORKER_APP, headers: { Origin: WORKER_SIBLING, "Sec-Fetch-Site": "same-origin" } },
    { name: "workers.dev same-site sibling", origin: WORKER_APP, headers: { Origin: WORKER_SIBLING, "Sec-Fetch-Site": "same-site" } },
  ];
}
