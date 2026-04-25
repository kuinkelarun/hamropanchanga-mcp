import { Router, type Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "./auth.js";
import { assertAdmin } from "./auth.js";
import {
  deleteUserConfig,
  getUserConfigDecrypted,
  getUserConfigMasked,
  saveUserConfig,
  getGlobalConfigMasked,
  getGlobalConfigDecrypted,
  saveGlobalConfig,
  deleteGlobalConfig,
  toggleGlobalConfig,
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

export function createAdminLlmConfigRouter(): Router {
  const router = Router();

  async function requireAdmin(req: AuthedRequest, res: Response): Promise<string | null> {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "Unauthenticated" });
      return null;
    }
    try {
      await assertAdmin(uid);
    } catch {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return uid;
  }

  router.get("/", async (req: AuthedRequest, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const cfg = await getGlobalConfigMasked();
      res.json(cfg);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/", async (req: AuthedRequest, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_config", details: parsed.error.flatten() });
      return;
    }
    try {
      const masked = await saveGlobalConfig(parsed.data);
      res.json(masked);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/", async (req: AuthedRequest, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      await deleteGlobalConfig();
      res.json({ configured: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/test", async (req: AuthedRequest, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      // Read raw doc so test works regardless of the enabled flag
      const { db } = await import("./firebase.js");
      const { decrypt } = await import("./encryption.js");
      const snap = await db().collection("systemConfig").doc("llmConfig").get();
      if (!snap.exists) {
        res.status(409).json({ ok: false, error: "llm_not_configured" });
        return;
      }
      const d = snap.data()!;
      let rawCfg = null as import("./llm-config-store.js").LlmConfigDecrypted | null;
      if (d.provider === "anthropic" && d.anthropic?.apiKeyCipher) {
        rawCfg = { provider: "anthropic", anthropic: { apiKey: decrypt({ cipher: d.anthropic.apiKeyCipher, iv: d.anthropic.apiKeyIv }), model: d.anthropic.model || "claude-opus-4-7" } };
      } else if (d.provider === "bedrock" && d.bedrock?.accessKeyIdCipher) {
        const b = d.bedrock;
        rawCfg = { provider: "bedrock", bedrock: { awsRegion: b.awsRegion, accessKeyId: decrypt({ cipher: b.accessKeyIdCipher, iv: b.accessKeyIdIv }), secretAccessKey: decrypt({ cipher: b.secretAccessKeyCipher, iv: b.secretAccessKeyIv }), sessionToken: b.sessionTokenCipher ? decrypt({ cipher: b.sessionTokenCipher, iv: b.sessionTokenIv }) : undefined, model: b.model || "anthropic.claude-opus-4-v1:0" } };
      }
      if (!rawCfg) {
        res.status(409).json({ ok: false, error: "llm_not_configured" });
        return;
      }
      const client = await buildLlmClientFromConfig(rawCfg);
      await client.create({ model: client.defaultModel, max_tokens: 16, messages: [{ role: "user", content: "ping" }] });
      res.json({ ok: true, provider: client.provider, model: client.defaultModel });
    } catch (err) {
      res.json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/toggle", async (req: AuthedRequest, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "expected { enabled: boolean }" });
      return;
    }
    try {
      await toggleGlobalConfig(parsed.data.enabled);
      res.json({ enabled: parsed.data.enabled });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
