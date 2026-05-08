import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTreeTools } from "./trees.js";
import { registerMemberTools } from "./members.js";
import { registerEventTools } from "./events.js";
import { registerTithiTools } from "./tithi.js";
import { registerCalendarTools } from "./calendar.js";
import { registerUserTools } from "./users.js";
import { registerApiKeyTools } from "./api-keys.js";

export function registerTools(server: McpServer, role: "admin" | "superuser" | "user" = "admin"): void {
  registerTreeTools(server);
  registerMemberTools(server);
  registerEventTools(server);
  registerTithiTools(server, role);
  registerCalendarTools(server);
  registerUserTools(server, role);
  registerApiKeyTools(server, role);
}

export function ok(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function err(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
