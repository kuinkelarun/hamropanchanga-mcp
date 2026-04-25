import express from "express";
import cors from "cors";
import { connectMcpServer } from "./mcp-client.js";
import { authMiddleware } from "./auth.js";
import { createChatHandler, createStreamingChatHandler } from "./chat.js";
import { createLlmConfigRouter } from "./llm-config-routes.js";
import { initFirebase } from "./firebase.js";

async function main(): Promise<void> {
  initFirebase();

  const command = process.env.MCP_SERVER_COMMAND ?? "node";
  const args = (process.env.MCP_SERVER_ARGS ?? "../mcp-server/dist/index.js").split(/\s+/);

  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }

  const mcp = await connectMcpServer({ command, args, env: childEnv });
  console.log(`[chat-backend] MCP connected (${mcp.tools.length} tools)`);

  const app = express();

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins.length ? allowedOrigins : true,
      credentials: false,
    }),
  );

  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      tools: mcp.tools.map((t) => t.name),
      fallbackEnvEnabled: process.env.LLM_CONFIG_FALLBACK_ENV === "true",
    });
  });

  app.use("/api/llm-config", authMiddleware, createLlmConfigRouter());
  app.post("/api/chat", authMiddleware, createChatHandler(mcp));
  app.post("/api/chat/stream", authMiddleware, createStreamingChatHandler(mcp));

  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => {
    console.log(`[chat-backend] listening on http://localhost:${port}`);
  });

  const shutdown = async () => {
    console.log("[chat-backend] shutting down");
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[chat-backend] fatal:", err);
  process.exit(1);
});
