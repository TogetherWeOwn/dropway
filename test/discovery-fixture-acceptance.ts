import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import type { ServerBindings } from "@dropway/server";
import * as helpers from "./helpers";

/** Observe the real fixture; never replace its reset, migrations or bootstrap. */
export function assertDiscoveryFixtureLifecycle(current: () => helpers.Instance) {
  const setup = vi.spyOn(helpers, "freshInstance");
  const seen = new WeakSet<helpers.Instance>();
  const canary = "test/discovery-fixture-canary";
  let anonymousEnabled = false;

  // Registered before the discovery setup hooks: every case starts with dirty
  // disposable storage, even when run alone or with a test-name filter.
  beforeEach(async () => {
    setup.mockClear();
    anonymousEnabled = false;
    await env.DB.exec("CREATE TABLE IF NOT EXISTS discovery_fixture_canary (id INTEGER PRIMARY KEY)");
    await env.DB.prepare("INSERT OR REPLACE INTO discovery_fixture_canary (id) VALUES (1)").run();
    await env.FILES.put(canary, "stale fixture");
    await env.CACHE.put(canary, "stale fixture");
  });

  afterEach(async () => {
    const instance = current();
    expect.soft(setup.mock.calls.length, "one freshInstance initialization per discovery case").toBe(1);
    // Compare booleans so a failed identity check cannot print an owner key.
    expect.soft(await setup.mock.results.at(-1)?.value === instance, "the case uses its freshly initialized instance").toBe(true);
    expect.soft(seen.has(instance), "instances cannot be reused across discovery cases").toBe(false);
    seen.add(instance);
    const context = instance.dropway.context(env as unknown as ServerBindings, createExecutionContext());
    expect.soft(context.config.anonymous.enabled, "the effective fixture preserves the case's anonymous mode").toBe(anonymousEnabled);
    expect.soft(await env.FILES.head(canary), "R2 state from before setup is absent").toBeNull();
    expect.soft(await env.CACHE.get(canary), "KV state from before setup is absent").toBeNull();
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovery_fixture_canary'").first();
    const staleRows = table ? await env.DB.prepare("SELECT COUNT(*) AS n FROM discovery_fixture_canary").first<{ n: number }>() : { n: 0 };
    expect.soft(staleRows?.n, "D1 state from before setup is absent").toBe(0);
  });

  afterAll(() => setup.mockRestore());

  // A mode-specific expectation only: it does not initialize a fixture.
  return (enabled: boolean) => {
    beforeEach(() => {
      anonymousEnabled = enabled;
    });
  };
}
