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
 * Throws an Error("forbidden") if the given uid is not in the adminList collection.
 * Use inside route handlers: await assertAdmin(uid) then catch as 403.
 */
export async function assertAdmin(uid: string): Promise<void> {
  const snap = await db().collection("adminList").doc(uid).get();
  if (!snap.exists) throw new Error("forbidden");
}
