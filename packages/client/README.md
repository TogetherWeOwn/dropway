# @dropway/client

Typed REST client for [Kofra](https://github.com/TogetherWeOwn/dropway), generated from the operation registry. Fetch-only with zero dependencies: runs on Node 20+, Cloudflare Workers and browsers. The `kofra` CLI's transport builds on this package.

```ts
import { DropwayClient } from "@dropway/client";

const client = new DropwayClient({ api: "https://kofra.example.workers.dev", token: "dw_..." });

const me = await client.whoami();
const site = await client.createSite({ slug: "hello" });
const bytes = await client.getFileBytes({ slug: "hello", path: "index.html" });
```

Every method mirrors one registry operation (`OPERATIONS` holds the table), so the client, the OpenAPI document, the MCP tools and the CLI stay in step. Failures throw `DropwayError` with the server's stable `code`, `message`, `hint`, `details`, HTTP `status` and a `retryable` flag.

Regenerate after registry changes: `npm run client:generate`.
