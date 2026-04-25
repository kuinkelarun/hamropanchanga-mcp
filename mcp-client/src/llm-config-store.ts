import { Timestamp } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import { decrypt, encrypt, last4 } from "./encryption.js";

const COLLECTION = "userLlmConfigs";

export type LlmProvider = "anthropic" | "bedrock";

export interface AnthropicConfigInput {
  apiKey: string;
  model?: string;
}

export interface BedrockConfigInput {
  awsRegion: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  model?: string;
}

export interface SaveConfigInput {
  provider: LlmProvider;
  anthropic?: AnthropicConfigInput;
  bedrock?: BedrockConfigInput;
}

export interface AnthropicConfigDecrypted {
  apiKey: string;
  model: string;
}

export interface BedrockConfigDecrypted {
  awsRegion: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  model: string;
}

export interface LlmConfigDecrypted {
  provider: LlmProvider;
  anthropic?: AnthropicConfigDecrypted;
  bedrock?: BedrockConfigDecrypted;
}

export interface MaskedConfig {
  configured: true;
  provider: LlmProvider;
  anthropic?: { model: string; apiKeyLast4: string };
  bedrock?: { awsRegion: string; model: string; accessKeyLast4: string; hasSessionToken: boolean };
}

export interface NotConfigured {
  configured: false;
}

export type ConfigResponse = MaskedConfig | NotConfigured;

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";
const DEFAULT_BEDROCK_MODEL = "anthropic.claude-opus-4-v1:0";

export async function getUserConfigMasked(uid: string): Promise<ConfigResponse> {
  const snap = await db().collection(COLLECTION).doc(uid).get();
  if (!snap.exists) return { configured: false };
  const data = snap.data()!;
  const provider = data.provider as LlmProvider | undefined;
  if (provider === "anthropic" && data.anthropic) {
    return {
      configured: true,
      provider: "anthropic",
      anthropic: {
        model: data.anthropic.model || DEFAULT_ANTHROPIC_MODEL,
        apiKeyLast4: data.anthropic.apiKeyLast4 || "",
      },
    };
  }
  if (provider === "bedrock" && data.bedrock) {
    return {
      configured: true,
      provider: "bedrock",
      bedrock: {
        awsRegion: data.bedrock.awsRegion || "",
        model: data.bedrock.model || DEFAULT_BEDROCK_MODEL,
        accessKeyLast4: data.bedrock.accessKeyLast4 || "",
        hasSessionToken: Boolean(data.bedrock.sessionTokenCipher),
      },
    };
  }
  return { configured: false };
}

export async function getUserConfigDecrypted(
  uid: string,
): Promise<LlmConfigDecrypted | null> {
  const snap = await db().collection(COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  const provider = data.provider as LlmProvider | undefined;
  if (provider === "anthropic" && data.anthropic?.apiKeyCipher) {
    return {
      provider: "anthropic",
      anthropic: {
        apiKey: decrypt({
          cipher: data.anthropic.apiKeyCipher,
          iv: data.anthropic.apiKeyIv,
        }),
        model: data.anthropic.model || DEFAULT_ANTHROPIC_MODEL,
      },
    };
  }
  if (provider === "bedrock" && data.bedrock?.accessKeyIdCipher) {
    const b = data.bedrock;
    return {
      provider: "bedrock",
      bedrock: {
        awsRegion: b.awsRegion,
        accessKeyId: decrypt({ cipher: b.accessKeyIdCipher, iv: b.accessKeyIdIv }),
        secretAccessKey: decrypt({
          cipher: b.secretAccessKeyCipher,
          iv: b.secretAccessKeyIv,
        }),
        sessionToken: b.sessionTokenCipher
          ? decrypt({ cipher: b.sessionTokenCipher, iv: b.sessionTokenIv })
          : undefined,
        model: b.model || DEFAULT_BEDROCK_MODEL,
      },
    };
  }
  return null;
}

export async function saveUserConfig(
  uid: string,
  input: SaveConfigInput,
): Promise<MaskedConfig> {
  const now = Timestamp.now();
  const ref = db().collection(COLLECTION).doc(uid);
  const existing = await ref.get();
  const createdAt = existing.exists ? existing.data()!.createdAt ?? now : now;

  if (input.provider === "anthropic") {
    if (!input.anthropic?.apiKey) throw new Error("anthropic.apiKey is required");
    const { cipher, iv } = encrypt(input.anthropic.apiKey);
    const model = input.anthropic.model || DEFAULT_ANTHROPIC_MODEL;
    await ref.set({
      provider: "anthropic",
      anthropic: {
        apiKeyCipher: cipher,
        apiKeyIv: iv,
        apiKeyLast4: last4(input.anthropic.apiKey),
        model,
      },
      bedrock: null,
      createdAt,
      updatedAt: now,
    });
    return {
      configured: true,
      provider: "anthropic",
      anthropic: { model, apiKeyLast4: last4(input.anthropic.apiKey) },
    };
  }

  if (input.provider === "bedrock") {
    const b = input.bedrock;
    if (!b?.awsRegion || !b.accessKeyId || !b.secretAccessKey) {
      throw new Error("bedrock.awsRegion, accessKeyId, and secretAccessKey are required");
    }
    const accessKey = encrypt(b.accessKeyId);
    const secretKey = encrypt(b.secretAccessKey);
    const session = b.sessionToken ? encrypt(b.sessionToken) : null;
    const model = b.model || DEFAULT_BEDROCK_MODEL;
    await ref.set({
      provider: "bedrock",
      anthropic: null,
      bedrock: {
        awsRegion: b.awsRegion,
        accessKeyIdCipher: accessKey.cipher,
        accessKeyIdIv: accessKey.iv,
        secretAccessKeyCipher: secretKey.cipher,
        secretAccessKeyIv: secretKey.iv,
        sessionTokenCipher: session?.cipher ?? null,
        sessionTokenIv: session?.iv ?? null,
        accessKeyLast4: last4(b.accessKeyId),
        model,
      },
      createdAt,
      updatedAt: now,
    });
    return {
      configured: true,
      provider: "bedrock",
      bedrock: {
        awsRegion: b.awsRegion,
        model,
        accessKeyLast4: last4(b.accessKeyId),
        hasSessionToken: Boolean(b.sessionToken),
      },
    };
  }

  throw new Error(`Unsupported provider: ${String(input.provider)}`);
}

export async function deleteUserConfig(uid: string): Promise<void> {
  await db().collection(COLLECTION).doc(uid).delete();
}

// ---------------------------------------------------------------------------
// Global (admin-managed) shared AI config
// ---------------------------------------------------------------------------

const GLOBAL_COLLECTION = "systemConfig";
const GLOBAL_DOC_ID = "llmConfig";

export interface GlobalMaskedConfig extends MaskedConfig {
  enabled: boolean;
}

export type GlobalConfigResponse =
  | GlobalMaskedConfig
  | (NotConfigured & { enabled?: boolean });

export async function getGlobalConfigMasked(): Promise<GlobalConfigResponse> {
  const snap = await db().collection(GLOBAL_COLLECTION).doc(GLOBAL_DOC_ID).get();
  if (!snap.exists) return { configured: false };
  const data = snap.data()!;
  const enabled: boolean = data.enabled === true;
  const provider = data.provider as LlmProvider | undefined;
  if (provider === "anthropic" && data.anthropic) {
    return {
      configured: true,
      enabled,
      provider: "anthropic",
      anthropic: {
        model: data.anthropic.model || DEFAULT_ANTHROPIC_MODEL,
        apiKeyLast4: data.anthropic.apiKeyLast4 || "",
      },
    };
  }
  if (provider === "bedrock" && data.bedrock) {
    return {
      configured: true,
      enabled,
      provider: "bedrock",
      bedrock: {
        awsRegion: data.bedrock.awsRegion || "",
        model: data.bedrock.model || DEFAULT_BEDROCK_MODEL,
        accessKeyLast4: data.bedrock.accessKeyLast4 || "",
        hasSessionToken: Boolean(data.bedrock.sessionTokenCipher),
      },
    };
  }
  return { configured: false, enabled };
}

/** Returns the decrypted config only if it exists AND is enabled. */
export async function getGlobalConfigDecrypted(): Promise<LlmConfigDecrypted | null> {
  const snap = await db().collection(GLOBAL_COLLECTION).doc(GLOBAL_DOC_ID).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  if (!data.enabled) return null;
  const provider = data.provider as LlmProvider | undefined;
  if (provider === "anthropic" && data.anthropic?.apiKeyCipher) {
    return {
      provider: "anthropic",
      anthropic: {
        apiKey: decrypt({ cipher: data.anthropic.apiKeyCipher, iv: data.anthropic.apiKeyIv }),
        model: data.anthropic.model || DEFAULT_ANTHROPIC_MODEL,
      },
    };
  }
  if (provider === "bedrock" && data.bedrock?.accessKeyIdCipher) {
    const b = data.bedrock;
    return {
      provider: "bedrock",
      bedrock: {
        awsRegion: b.awsRegion,
        accessKeyId: decrypt({ cipher: b.accessKeyIdCipher, iv: b.accessKeyIdIv }),
        secretAccessKey: decrypt({ cipher: b.secretAccessKeyCipher, iv: b.secretAccessKeyIv }),
        sessionToken: b.sessionTokenCipher
          ? decrypt({ cipher: b.sessionTokenCipher, iv: b.sessionTokenIv })
          : undefined,
        model: b.model || DEFAULT_BEDROCK_MODEL,
      },
    };
  }
  return null;
}

/** Saves (or overwrites) the global config. Does NOT touch the enabled flag. */
export async function saveGlobalConfig(input: SaveConfigInput): Promise<GlobalMaskedConfig> {
  const now = Timestamp.now();
  const ref = db().collection(GLOBAL_COLLECTION).doc(GLOBAL_DOC_ID);
  const existing = await ref.get();
  const createdAt = existing.exists ? existing.data()!.createdAt ?? now : now;
  // Default to enabled:true on first save so the key is immediately active.
  // On subsequent saves the existing enabled state is preserved.
  const enabled: boolean = existing.exists ? Boolean(existing.data()!.enabled) : true;

  if (input.provider === "anthropic") {
    if (!input.anthropic?.apiKey) throw new Error("anthropic.apiKey is required");
    const { cipher, iv } = encrypt(input.anthropic.apiKey);
    const model = input.anthropic.model || DEFAULT_ANTHROPIC_MODEL;
    await ref.set({
      provider: "anthropic",
      enabled,
      anthropic: {
        apiKeyCipher: cipher,
        apiKeyIv: iv,
        apiKeyLast4: last4(input.anthropic.apiKey),
        model,
      },
      bedrock: null,
      createdAt,
      updatedAt: now,
    });
    return { configured: true, enabled, provider: "anthropic", anthropic: { model, apiKeyLast4: last4(input.anthropic.apiKey) } };
  }

  if (input.provider === "bedrock") {
    const b = input.bedrock;
    if (!b?.awsRegion || !b.accessKeyId || !b.secretAccessKey) {
      throw new Error("bedrock.awsRegion, accessKeyId, and secretAccessKey are required");
    }
    const accessKey = encrypt(b.accessKeyId);
    const secretKey = encrypt(b.secretAccessKey);
    const session = b.sessionToken ? encrypt(b.sessionToken) : null;
    const model = b.model || DEFAULT_BEDROCK_MODEL;
    await ref.set({
      provider: "bedrock",
      enabled,
      anthropic: null,
      bedrock: {
        awsRegion: b.awsRegion,
        accessKeyIdCipher: accessKey.cipher,
        accessKeyIdIv: accessKey.iv,
        secretAccessKeyCipher: secretKey.cipher,
        secretAccessKeyIv: secretKey.iv,
        sessionTokenCipher: session?.cipher ?? null,
        sessionTokenIv: session?.iv ?? null,
        accessKeyLast4: last4(b.accessKeyId),
        model,
      },
      createdAt,
      updatedAt: now,
    });
    return {
      configured: true,
      enabled,
      provider: "bedrock",
      bedrock: { awsRegion: b.awsRegion, model, accessKeyLast4: last4(b.accessKeyId), hasSessionToken: Boolean(b.sessionToken) },
    };
  }

  throw new Error(`Unsupported provider: ${String(input.provider)}`);
}

export async function deleteGlobalConfig(): Promise<void> {
  await db().collection(GLOBAL_COLLECTION).doc(GLOBAL_DOC_ID).delete();
}

export async function toggleGlobalConfig(enabled: boolean): Promise<void> {
  await db().collection(GLOBAL_COLLECTION).doc(GLOBAL_DOC_ID).update({ enabled });
}
