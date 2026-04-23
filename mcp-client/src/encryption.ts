import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.LLM_CONFIG_ENC_KEY;
  if (!raw) {
    throw new Error(
      "LLM_CONFIG_ENC_KEY is not set. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `LLM_CONFIG_ENC_KEY must decode to 32 bytes (got ${buf.length}). Generate a fresh one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  cachedKey = buf;
  return buf;
}

export interface CipherPayload {
  cipher: string; // base64 of (ciphertext || auth tag)
  iv: string; // base64
}

export function encrypt(plaintext: string): CipherPayload {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function decrypt(payload: CipherPayload): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, "base64");
  const buf = Buffer.from(payload.cipher, "base64");
  if (buf.length < TAG_BYTES) throw new Error("Ciphertext too short");
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(0, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

export function last4(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(-4);
}
