import { AsyncLocalStorage } from "node:async_hooks";
import admin from "firebase-admin";
import { db } from "./firebase.js";
import { COLLECTIONS } from "./constants.js";

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

export async function getAuthContext(): Promise<AuthContext> {
  const ctx = contextStorage.getStore();
  if (ctx) return ctx;
  const uid = process.env.TEST_USER_ID;
  if (!uid) {
    throw new Error(
      "No auth context. In stdio mode set TEST_USER_ID; in HTTP mode wrap tool execution in runWithAuth().",
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
