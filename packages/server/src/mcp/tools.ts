import { CORE_OPERATIONS } from "../operations/core";
import { operationTools } from "../operations";

/** Compatibility export. Core tools are generated from the operation registry. */
export const CORE_MCP_TOOLS = operationTools(CORE_OPERATIONS);
