import { Router } from "express";
import { z } from "zod";
import type { AuthedRequest } from "./auth.js";
import {
  deleteUserConfig,
  getUserConfigDecrypted,
  getUserConfigMasked,
  saveUserConfig,
} from "./llm-config-store.js";
import { buildLlmClientFromConfig } from "./providers.js";

const anthropicSchema = z.object({
  apiKey: z.string().min(10),
  model: z.string().optional(),
});

const bedrockSchema = z.object({
  awsRegion: z.string().min(1),
  accessKeyId: z.string().min(10),
  secretAccessKey: z.string().min(10),
  sessionToken: z.string().optional(),
  model: z.string().optional(),
});

const saveSchema = z
  .object({
    provider: z.enum(["anthropic", "bedrock"]),
    anthropic: anthropicSchema.optional(),
    bedrock: bedrockSchema.optional(),
  })
  .refine(
    (v) =>
      (v.provider === "anthropic" && v.anthropic) ||
      (v.provider === "bedrock" && v.bedrock),
    { message: "Config block must match selected provider" },
  );

export function createLlmConfigRouter(): Router {
  const router = Router();

  router.get("/", async (req: AuthedRequest, res) => {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const cfg = await getUserConfigMasked(uid);
      res.json(cfg);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/", async (req: AuthedRequest, res) => {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_config", details: parsed.error.flatten() });
      return;
    }
    try {
      const masked = await saveUserConfig(uid, parsed.data);
      res.json(masked);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/", async (req: AuthedRequest, res) => {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      await deleteUserConfig(uid);
      res.json({ configured: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/test", async (req: AuthedRequest, res) => {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    try {
      const cfg = await getUserConfigDecrypted(uid);
      if (!cfg) {
        res.status(409).json({ ok: false, error: "llm_not_configured" });
        return;
      }
      const client = await buildLlmClientFromConfig(cfg);
      await client.create({
        model: client.defaultModel,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
      res.json({ ok: true, provider: client.provider, model: client.defaultModel });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
