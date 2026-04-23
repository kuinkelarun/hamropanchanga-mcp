import admin from "firebase-admin";
import { getFirestore, Firestore } from "firebase-admin/firestore";

let app: admin.app.App | null = null;
let firestore: Firestore | null = null;

export function initFirebase(): void {
  if (app) return;

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (svcJson) {
    app = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(svcJson)),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  } else {
    app = admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }
}

export function db(): Firestore {
  if (!firestore) {
    if (!app) initFirebase();
    const databaseId = process.env.FIREBASE_DATABASE_ID || "(default)";
    firestore = getFirestore(app!, databaseId);
  }
  return firestore;
}
