#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { initFirebase } from "./firebase.js";
import { registerTools } from "./tools/index.js";
import { loadAuthContext, runWithAuth, verifyFirebaseIdToken, verifyApiKey, verifyMcpAccessToken } from "./auth.js";
import {
  handleOAuthMetadata,
  handleClientRegistration,
  handleAuthorize,
  handleOAuthCallback,
  handleTokenExchange,
} from "./oauth.js";

// HTTP/SSE entry point for hosted deployment.
// Supports three authentication methods:
//   1. npcal_* API key      — manually-issued keys (Claude Desktop, MCP Inspector, etc.)
//   2. MCP OAuth JWT        — issued by this server's /token endpoint (Claude.ai, Cursor, etc.)
//   3. Firebase ID token    — in-app chat backend

async function resolveUidFromRequest(req: express.Request): Promise<string> {
  const devUid = process.env.DEV_PASSTHROUGH_UID;
  if (devUid) return devUid;

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error("Missing Bearer token");

  const token = match[1];

  // npcal_* prefix → API key auth (backward compat, no Firebase SDK needed)
  if (token.startsWith("npcal_")) {
    return verifyApiKey(token);
  }

  // JWT with correct issuer → MCP OAuth access token
  if (process.env.MCP_SERVER_BASE_URL && process.env.MCP_JWT_SECRET) {
    try {
      return verifyMcpAccessToken(token);
    } catch {
      // Not a valid MCP JWT — fall through to Firebase
    }
  }

  // Default → Firebase ID token (in-app users)
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
  // OAuth token endpoint requires form-encoded body (RFC 6749)
  app.use(express.urlencoded({ extended: false }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/public", express.static(path.join(__dirname, "../public")));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ── OAuth 2.1 endpoints (MCP Authorization spec) ──────────────────────────
  app.get("/.well-known/oauth-authorization-server", handleOAuthMetadata);
  // OAuth Protected Resource Metadata (RFC 9470) — tells clients where the MCP endpoint is
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const base = (process.env.MCP_SERVER_BASE_URL ?? "").replace(/\/$/, "");
    res.json({
      resource: base,
      authorization_servers: [base],
    });
  });
  app.post("/register", handleClientRegistration);
  app.get("/authorize", handleAuthorize);
  app.get("/oauth/callback", handleOAuthCallback);
  app.post("/token", handleTokenExchange);

  // Handle MCP requests at both /mcp and / (Claude.ai posts to the base URL)
  async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
    const existingSessionId = req.header("mcp-session-id");

    // ── Existing session: route to the stored transport ──
    if (existingSessionId && sessions.has(existingSessionId)) {
      const { transport, uid } = sessions.get(existingSessionId)!;
      try {
        const ctx = await loadAuthContext(uid);
        await runWithAuth(ctx, () => transport.handleRequest(req, res, req.body));
      } catch (err) {
        console.error(`[mcp] ${req.method} ${req.path} session error:`, (err as Error).message);
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
      console.warn(`[mcp] ${req.method} ${req.path} auth failed:`, (err as Error).message);
      res.status(401).json({ error: (err as Error).message });
      return;
    }

    try {
      const ctx = await loadAuthContext(uid);
      await runWithAuth(ctx, async () => {
        const baseUrl = process.env.MCP_SERVER_BASE_URL;
        const server = new McpServer({
          name: "hamropanchanga",
          version: "0.1.0",
          title: "HamroPanchanga",
          description: "Nepali calendar, tithi, family tree and events MCP server",
          ...(baseUrl && {
            icons: [{ src: `${baseUrl}/public/HamroPanchangaLogo.png`, mimeType: "image/png" }],
          }),
        });
        registerTools(server);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { transport, uid });
          },
        });

        transport.onerror = (err) => {
          console.error(`[mcp-transport] ${req.method} ${req.path} error:`, err.message);
        };

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
  }

  app.all("/mcp", handleMcp);
  app.all("/", handleMcp);

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`[hamropanchanga-mcp] HTTP transport listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[hamropanchanga-mcp] fatal:", err);
  process.exit(1);
});
