#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initFirebase } from "./firebase.js";
import { registerTools } from "./tools/index.js";
import { loadAuthContext, runWithAuth, verifyFirebaseIdToken, verifyApiKey } from "./auth.js";

// HTTP/SSE entry point for hosted deployment.
// Supports two authentication methods:
//   1. npcal_* API key  — external clients (Claude Desktop, Claude Code, Copilot, MCP Inspector)
//   2. Firebase ID token — in-app chat backend (x-auth-type: firebase, default)

async function resolveUidFromRequest(req: express.Request): Promise<string> {
  const devUid = process.env.DEV_PASSTHROUGH_UID;
  if (devUid) return devUid;

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Bearer token");

  const token = match[1];

  // npcal_* prefix → API key auth (external clients, no Firebase SDK needed)
  if (token.startsWith("npcal_")) {
    return verifyApiKey(token);
  }

  // Default → Firebase ID token
  return verifyFirebaseIdToken(token);
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  uid: string;
}

async function main(): Promise<void> {
  initFirebase();

  // Session store: mcp-session-id → active transport + owner uid
  const sessions = new Map<string, McpSession>();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", async (req, res) => {
    const existingSessionId = req.header("mcp-session-id");

    // ── Existing session: route to the stored transport ──
    if (existingSessionId && sessions.has(existingSessionId)) {
      const { transport, uid } = sessions.get(existingSessionId)!;
      try {
        const ctx = await loadAuthContext(uid);
        await runWithAuth(ctx, () => transport.handleRequest(req, res, req.body));
      } catch (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: (err as Error).message });
        }
      }
      return;
    }

    // ── New session: authenticate and initialise ──
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
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, uid });
          },
        });

        transport.onclose = () => {
          for (const [id, s] of sessions) {
            if (s.transport === transport) {
              sessions.delete(id);
              break;
            }
          }
        };

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
