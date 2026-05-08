import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS } from "../constants.js";
import { assertAdmin, getAuthContext } from "../auth.js";
import { ok } from "./index.js";

function mintRawKey(): string {
  return "npcal_" + randomBytes(24).toString("hex");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function registerApiKeyTools(server: McpServer, role: "admin" | "superuser" | "user" = "admin"): void {
  server.tool(
    "request_api_key",
    "Submit an API key request. Admins review requests before keys are issued.",
    {
      use_case: z.string().min(1),
      website: z.string().optional(),
      name: z.string().optional(),
    },
    async ({ use_case, website, name }) => {
      const ctx = await getAuthContext();
      const payload = {
        uid: ctx.uid,
        email: ctx.email,
        name: name ?? "",
        useCase: use_case,
        website: website ?? "",
        status: "pending",
        createdAt: Timestamp.now(),
      };
      const ref = await db().collection(COLLECTIONS.API_KEY_REQUESTS).add(payload);
      return ok({ id: ref.id, ...payload });
    },
  );

  server.tool(
    "list_my_api_key_requests",
    "List the caller's own API key requests with current status.",
    {},
    async () => {
      const ctx = await getAuthContext();
      const snap = await db()
        .collection(COLLECTIONS.API_KEY_REQUESTS)
        .where("uid", "==", ctx.uid)
        .get();
      const requests = snap.docs.map((d) => {
        const data = d.data();
        const { rawKey, ...rest } = data;
        return {
          id: d.id,
          ...rest,
          rawKeyAvailable: !!rawKey && !data.rawKeyAcknowledged,
        };
      });
      return ok({ count: requests.length, requests });
    },
  );

  server.tool(
    "get_my_api_keys",
    "List active API keys belonging to the caller. Raw keys are never returned — only metadata.",
    {},
    async () => {
      const ctx = await getAuthContext();
      const snap = await db()
        .collection(COLLECTIONS.API_KEYS)
        .where("uid", "==", ctx.uid)
        .where("active", "==", true)
        .get();
      const keys = snap.docs.map((d) => {
        const { keyHash, ...rest } = d.data();
        return { id: d.id, ...rest };
      });
      return ok({ count: keys.length, keys });
    },
  );

  if (role !== "admin") return;

  server.tool(
    "list_api_key_requests",
    "Admin-only. List API key requests, optionally filtered by status.",
    {
      status: z.enum(["pending", "approved", "rejected"]).optional(),
    },
    async ({ status }) => {
      assertAdmin(await getAuthContext());
      let q: FirebaseFirestore.Query = db().collection(COLLECTIONS.API_KEY_REQUESTS);
      if (status) q = q.where("status", "==", status);
      const snap = await q.get();
      const requests = snap.docs.map((d) => {
        const data = d.data();
        const { rawKey, ...rest } = data;
        return { id: d.id, ...rest };
      });
      return ok({ count: requests.length, requests });
    },
  );

  server.tool(
    "approve_api_key_request",
    "Admin-only. Approve a pending request: mints a new key, stores its hash, and returns the raw key ONCE (clients must store it, it cannot be retrieved again).",
    {
      request_id: z.string(),
      plan: z.enum(["free", "pro"]).optional().default("free"),
      rate_limit: z.number().int().min(1).max(1_000_000).optional().default(1000),
    },
    async ({ request_id, plan, rate_limit }) => {
      const ctx = await getAuthContext();
      assertAdmin(ctx);
      const firestore = db();
      const reqRef = firestore.collection(COLLECTIONS.API_KEY_REQUESTS).doc(request_id);
      const reqDoc = await reqRef.get();
      if (!reqDoc.exists) throw new Error(`Request ${request_id} not found`);
      const req = reqDoc.data()!;
      if (req.status === "approved") throw new Error("Already approved");

      const rawKey = mintRawKey();
      const keyRef = await firestore.collection(COLLECTIONS.API_KEYS).add({
        keyHash: sha256(rawKey),
        owner: req.name ?? req.email ?? "",
        email: req.email,
        uid: req.uid,
        plan,
        active: true,
        rateLimit: rate_limit,
        requestsToday: 0,
        rateLimitDate: new Date().toISOString().slice(0, 10),
        createdAt: Timestamp.now(),
        lastUsed: null,
      });

      await reqRef.update({
        status: "approved",
        keyId: keyRef.id,
        rawKey,
        rawKeyAcknowledged: false,
        reviewedAt: Timestamp.now(),
        reviewedBy: ctx.uid,
      });

      return ok({
        request_id,
        key_id: keyRef.id,
        raw_key: rawKey,
        plan,
        rate_limit,
        warning: "Show this raw_key to the requester ONCE. It cannot be retrieved again.",
      });
    },
  );

  server.tool(
    "reject_api_key_request",
    "Admin-only. Reject a pending API key request.",
    {
      request_id: z.string(),
      reason: z.string().optional(),
    },
    async ({ request_id, reason }) => {
      const ctx = await getAuthContext();
      assertAdmin(ctx);
      await db()
        .collection(COLLECTIONS.API_KEY_REQUESTS)
        .doc(request_id)
        .update({
          status: "rejected",
          rejectionReason: reason ?? "",
          reviewedAt: Timestamp.now(),
          reviewedBy: ctx.uid,
        });
      return ok({ request_id, rejected: true });
    },
  );

  server.tool(
    "regenerate_api_key",
    "Admin-only. Invalidate the old key and issue a new raw key for a previously approved request.",
    { request_id: z.string() },
    async ({ request_id }) => {
      const ctx = await getAuthContext();
      assertAdmin(ctx);
      const firestore = db();
      const reqRef = firestore.collection(COLLECTIONS.API_KEY_REQUESTS).doc(request_id);
      const reqDoc = await reqRef.get();
      if (!reqDoc.exists) throw new Error(`Request ${request_id} not found`);
      const req = reqDoc.data()!;
      if (!req.keyId) throw new Error("Request has no keyId; approve first");

      const rawKey = mintRawKey();
      await firestore.collection(COLLECTIONS.API_KEYS).doc(req.keyId).update({
        keyHash: sha256(rawKey),
        active: true,
        requestsToday: 0,
        rateLimitDate: new Date().toISOString().slice(0, 10),
      });
      await reqRef.update({
        rawKey,
        rawKeyAcknowledged: false,
        regeneratedAt: Timestamp.now(),
        regeneratedBy: ctx.uid,
      });
      return ok({
        request_id,
        key_id: req.keyId,
        raw_key: rawKey,
        warning: "Show this raw_key to the requester ONCE.",
      });
    },
  );

  server.tool(
    "revoke_api_key",
    "Admin-only. Deactivate an API key.",
    { key_id: z.string() },
    async ({ key_id }) => {
      assertAdmin(await getAuthContext());
      await db().collection(COLLECTIONS.API_KEYS).doc(key_id).update({ active: false });
      return ok({ key_id, active: false });
    },
  );
}
