import Anthropic from "@anthropic-ai/sdk";
import type { LlmConfigDecrypted, LlmProvider } from "./llm-config-store.js";
import { getUserConfigDecrypted, getGlobalConfigDecrypted } from "./llm-config-store.js";

export type { LlmProvider };

export interface LlmClient {
  create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  defaultModel: string;
  provider: LlmProvider;
}

export async function buildLlmClientFromConfig(
  cfg: LlmConfigDecrypted,
): Promise<LlmClient> {
  if (cfg.provider === "bedrock" && cfg.bedrock) {
    const mod = await import("@anthropic-ai/bedrock-sdk");
    const AnthropicBedrock = (mod as { default?: unknown; AnthropicBedrock?: unknown })
      .default ?? (mod as { AnthropicBedrock?: unknown }).AnthropicBedrock;
    const AnthropicBedrockCtor = AnthropicBedrock as unknown as new (opts: {
      awsRegion: string;
      awsAccessKey: string;
      awsSecretKey: string;
      awsSessionToken?: string;
    }) => { messages: { create: (p: unknown) => Promise<Anthropic.Message> } };

    const client = new AnthropicBedrockCtor({
      awsRegion: cfg.bedrock.awsRegion,
      awsAccessKey: cfg.bedrock.accessKeyId,
      awsSecretKey: cfg.bedrock.secretAccessKey,
      awsSessionToken: cfg.bedrock.sessionToken,
    });
    return {
      provider: "bedrock",
      defaultModel: cfg.bedrock.model,
      create: (params) =>
        client.messages.create(params) as unknown as Promise<Anthropic.Message>,
    };
  }

  if (cfg.provider === "anthropic" && cfg.anthropic) {
    const client = new Anthropic({ apiKey: cfg.anthropic.apiKey });
    return {
      provider: "anthropic",
      defaultModel: cfg.anthropic.model,
      create: (params) => client.messages.create(params),
    };
  }

  throw new Error("Invalid LLM config");
}

async function buildFromEnv(): Promise<LlmClient | null> {
  const provider = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  if (provider === "bedrock" && process.env.AWS_REGION) {
    return buildLlmClientFromConfig({
      provider: "bedrock",
      bedrock: {
        awsRegion: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
        sessionToken: process.env.AWS_SESSION_TOKEN,
        model: process.env.BEDROCK_MODEL ?? "anthropic.claude-opus-4-v1:0",
      },
    });
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return buildLlmClientFromConfig({
      provider: "anthropic",
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
      },
    });
  }
  return null;
}

export async function createLlmClientForUser(uid: string): Promise<LlmClient | null> {
  // 1. User's own config takes priority
  const cfg = await getUserConfigDecrypted(uid);
  if (cfg) return buildLlmClientFromConfig(cfg);
  // 2. Admin-shared global config (only if enabled)
  const globalCfg = await getGlobalConfigDecrypted();
  if (globalCfg) return buildLlmClientFromConfig(globalCfg);
  // 3. Env fallback
  if (process.env.LLM_CONFIG_FALLBACK_ENV === "true") {
    return buildFromEnv();
  }
  return null;
}

export async function createLlmClient(): Promise<LlmClient | null> {
  return buildFromEnv();
}
