#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initFirebase } from "./firebase.js";
import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  initFirebase();

  const server = new McpServer({
    name: "hamropanchanga",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[hamropanchanga-mcp] fatal:", err);
  process.exit(1);
});
