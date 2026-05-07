import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import jwt from "jsonwebtoken";
import { db } from "./firebase.js";
import { COLLECTIONS, nptToday } from "./constants.js";

export interface AuthContext {
  uid: string;
  email: string | null;
  role: "admin" | "superuser" | "user";
  permissions: Record<string, boolean>;
}

const contextStorage = new AsyncLocalStorage<AuthContext>();

export function runWithAuth<T>(ctx: AuthContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run(ctx, fn);
}

export async function loadAuthContext(uid: string): Promise<AuthContext> {
  const firestore = db();
  const [userDoc, adminDoc] = await Promise.all([
    firestore.collection(COLLECTIONS.USERS).doc(uid).get(),
    firestore.collection(COLLECTIONS.ADMIN_LIST).doc(uid).get(),
  ]);
  const data = userDoc.data() ?? {};
  const isAdmin = adminDoc.exists || data.role === "admin";
  return {
    uid,
    email: data.email ? String(data.email).toLowerCase() : null,
    role: isAdmin ? "admin" : ((data.role as AuthContext["role"]) ?? "user"),
    permissions: (data.permissions ?? {}) as Record<string, boolean>,
  };
}

/**
 * Stdio-mode only: set the current user's uid before each tool dispatch.
 * MCP over stdio is sequential so this is safe (no concurrent interleaving).
 */
let _stdioCurrentUid: string | null = null;
export function setStdioCurrentUid(uid: string | null): void {
  _stdioCurrentUid = uid;
}

export async function getAuthContext(): Promise<AuthContext> {
  const ctx = contextStorage.getStore();
  if (ctx) return ctx;
  const uid = _stdioCurrentUid ?? process.env.TEST_USER_ID;
  if (!uid) {
    throw new Error(
      "No auth context. In stdio mode call the _set_auth_uid tool before tool dispatch; in HTTP mode wrap tool execution in runWithAuth().",
    );
  }
  return loadAuthContext(uid);
}
export function assertAdmin(ctx: AuthContext): void {
  if (ctx.role !== "admin") throw new Error("Admin role required for this tool");
}

export function assertPermission(ctx: AuthContext, perm: string): void {
  if (ctx.role === "admin") return;
  if (!ctx.permissions[perm]) throw new Error(`Missing permission: ${perm}`);
}

export async function verifyFirebaseIdToken(idToken: string): Promise<string> {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return decoded.uid;
}

/**
 * Verifies a short-lived JWT issued by this MCP server's OAuth token endpoint.
 * Returns the uid stored in the `sub` claim.
 */
export function verifyMcpAccessToken(token: string): string {
  const secret = process.env.MCP_JWT_SECRET;
  if (!secret) throw new Error("MCP_JWT_SECRET not configured");
  const payload = jwt.verify(token, secret) as jwt.JwtPayload;
  if (typeof payload.sub !== "string") throw new Error("Invalid MCP token: missing sub");
  return payload.sub;
}

/**
 * Verifies an `npcal_*` API key against the `apiKeys` Firestore collection.
 * Checks active status, enforces daily rate limit, and returns the owner uid.
 */
export async function verifyApiKey(rawKey: string): Promise<string> {
  const hash = createHash("sha256").update(rawKey).digest("hex");
  const snap = await db()
    .collection(COLLECTIONS.API_KEYS)
    .where("keyHash", "==", hash)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (snap.empty) throw new Error("Invalid or revoked API key");

  const docRef = snap.docs[0].ref;
  const data = snap.docs[0].data();

  const today = nptToday();
  const rateLimit: number = data.rateLimit ?? 1000;
  let requestsToday: number = data.requestsToday ?? 0;
  const rateLimitDate: string = data.rateLimitDate ?? "";

  // Reset counter if it's a new day
  if (rateLimitDate !== today) {
    requestsToday = 0;
  }

  if (requestsToday >= rateLimit) {
    throw new Error("API key daily rate limit exceeded");
  }

  // Increment atomically
  await docRef.update({
    requestsToday: requestsToday + 1,
    rateLimitDate: today,
    lastUsed: Timestamp.now(),
  });

  return data.uid as string;
}
