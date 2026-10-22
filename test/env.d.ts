import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      FILES: R2Bucket;
      CACHE: KVNamespace;
      ANALYTICS?: AnalyticsEngineDataset;
      ADMIN_BOOTSTRAP_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
