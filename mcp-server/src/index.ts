#!/usr/bin/env node
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initFirebase } from "./firebase.js";
import { registerTools } from "./tools/index.js";
import { setStdioCurrentUid } from "./auth.js";

async function main(): Promise<void> {
  initFirebase();

  const server = new McpServer({
    name: "hamropanchanga",
    version: "0.1.0",
  });

  // Internal tool: called by mcp-client before each user tool dispatch to set
  // the current user's auth context. Hidden from the LLM (filtered client-side).
  server.tool(
    "_set_auth_uid",
    "Internal: set authentication context before tool dispatch.",
    { uid: z.string() },
    async ({ uid }) => {
      setStdioCurrentUid(uid);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[hamropanchanga-mcp] fatal:", err);
  process.exit(1);
});
