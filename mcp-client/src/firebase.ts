import admin from "firebase-admin";
import { getFirestore, Firestore } from "firebase-admin/firestore";

let app: admin.app.App | null = null;
let firestore: Firestore | null = null;

export function initFirebase(): admin.app.App {
  if (app) return app;
  if (admin.apps.length > 0) {
    app = admin.app();
    return app;
  }

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
  return app;
}

export function db(): Firestore {
  if (!firestore) {
    const current = initFirebase();
    const databaseId = process.env.FIREBASE_DATABASE_ID || "(default)";
    firestore = getFirestore(current, databaseId);
  }
  return firestore;
}
