#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initFirebase } from "./firebase.js";
import { registerTools } from "./tools/index.js";
import { loadAuthContext, runWithAuth, verifyFirebaseIdToken } from "./auth.js";

// HTTP/SSE entry point for hosted deployment (Phase 3).
// Authenticates each request before dispatching to the MCP server.

async function resolveUidFromRequest(req: express.Request): Promise<string> {
  const devUid = process.env.DEV_PASSTHROUGH_UID;
  if (devUid) return devUid;

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Bearer token");

  const authType = (req.header("x-auth-type") ?? "firebase").toLowerCase();
  if (authType === "firebase") {
    return verifyFirebaseIdToken(match[1]);
  }
  // TODO Phase 3: OAuth access token verification for external Claude clients.
  throw new Error(`Unsupported x-auth-type: ${authType}`);
}

async function main(): Promise<void> {
  initFirebase();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", async (req, res) => {
    let uid: string;
    try {
      uid = await resolveUidFromRequest(req);
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
      return;
    }

    try {
      const ctx = await loadAuthContext(uid);
      await runWithAuth(ctx, async () => {
        const server = new McpServer({ name: "hamropanchanga", version: "0.1.0" });
        registerTools(server);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`[hamropanchanga-mcp] HTTP transport listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[hamropanchanga-mcp] fatal:", err);
  process.exit(1);
});
