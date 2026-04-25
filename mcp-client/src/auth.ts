import type { Request, Response, NextFunction } from "express";
import admin from "firebase-admin";
import { db } from "./firebase.js";

let initialized = false;

function initFirebaseIfNeeded(): void {
  if (initialized) return;
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  }
  initialized = true;
}

export interface AuthedRequest extends Request {
  uid?: string;
}

export async function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const passthrough = process.env.DEV_PASSTHROUGH_UID;
  if (passthrough) {
    req.uid = passthrough;
    next();
    return;
  }

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  try {
    initFirebaseIfNeeded();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid Firebase ID token" });
  }
}

/**
 * Throws an Error("forbidden") unless the uid is recognised as admin by any
 * of the three mechanisms used in the app:
 *   1. adminList/{uid} Firestore doc exists
 *   2. Firebase custom claim  customClaims.admin === true
 *   3. users/{uid}.role === 'admin'
 */
export async function assertAdmin(uid: string): Promise<void> {
  // 1. adminList collection
  const adminSnap = await db().collection("adminList").doc(uid).get();
  if (adminSnap.exists) return;

  // 2. Firebase custom claims
  try {
    const userRecord = await admin.auth().getUser(uid);
    if ((userRecord.customClaims as Record<string, unknown> | undefined)?.admin === true) return;
  } catch {
    // getUser failure is non-fatal for this check
  }

  // 3. users collection role field
  const userSnap = await db().collection("users").doc(uid).get();
  if (userSnap.exists && userSnap.data()?.role === "admin") return;

  throw new Error("forbidden");
}
