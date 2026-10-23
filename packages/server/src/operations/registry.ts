import { z } from "zod";
import { CORE_OPERATIONS } from "./core";
import { commandTable, defineOperation, type OperationDefinition } from "../operations";

/** Build per instance so discovery and extension registrations never leak between apps. */
export function createOperationRegistry(extra: readonly OperationDefinition[] = []): OperationDefinition[] {
  const table = defineOperation({
    id: "list_operations",
    method: "GET",
    path: "/api/v1/operations",
    toolset: "discovery",
    scopes: [],
    anonymous: true,
    summary: "List API operations and CLI commands",
    description:
      "Discover this instance's operation ids, methods, paths, required scopes, JSON input schemas and CLI paths. Public metadata only; this does not grant permission to execute an operation.",
    input: z.object({}),
    output: z.object({
      operations: z.array(z.record(z.string(), z.unknown())),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    mcp: {
      exclude: "Discovery table; tools/list exposes the model tool schemas.",
    },
    examples: [
      {
        input: {},
        output: {
          operations: [
            {
              id: "whoami",
              method: "GET",
              path: "/api/v1/me",
              scopes: [],
              inputSchema: { type: "object", properties: {} },
              cli: { command: ["whoami"] },
            },
          ],
        },
      },
    ],
    async handler() {
      return { operations: commandTable(operations) };
    },
  });
  // Replacement by id keeps the original order while retaining extension metadata and handler.
  const operations: OperationDefinition[] = [...new Map([...CORE_OPERATIONS, table, ...extra].map((op) => [op.id, defineOperation(op)] as const)).values()];
  return operations;
}
