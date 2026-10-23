import { CORE_API_OPERATIONS } from "./core-api";
import { SITE_OPERATIONS } from "./sites";
import { VERSION_OPERATIONS } from "./versions";
import { KEY_OPERATIONS } from "./keys";
import { MEMBER_OPERATIONS } from "./members";
import { HTTP_OPERATIONS } from "./http";
import { TRANSFER_OPERATIONS } from "./transfers";
import { AUTH_OPERATIONS } from "../routes/auth";

/** Stable core order: generated MCP tools and every legacy REST transport. */
export const CORE_OPERATIONS = [...CORE_API_OPERATIONS, ...SITE_OPERATIONS, ...VERSION_OPERATIONS, ...KEY_OPERATIONS, ...MEMBER_OPERATIONS, ...HTTP_OPERATIONS, ...TRANSFER_OPERATIONS, ...AUTH_OPERATIONS];
