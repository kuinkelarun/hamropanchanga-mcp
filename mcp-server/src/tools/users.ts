import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS } from "../constants.js";
import { assertAdmin, getAuthContext } from "../auth.js";
import { ok } from "./index.js";

const ROLE = z.enum(["admin", "superuser", "user"]);

const PERMISSIONS_SCHEMA = z
  .object({
    manageUsers: z.boolean().optional(),
    manageHomeCards: z.boolean().optional(),
    manageTithis: z.boolean().optional(),
    manageEvents: z.boolean().optional(),
    manageCalendar: z.boolean().optional(),
    bulkUpload: z.boolean().optional(),
    manualDashboard: z.boolean().optional(),
    viewAllCustomers: z.boolean().optional(),
    manageOwnCustomers: z.boolean().optional(),
    viewOwnCustomers: z.boolean().optional(),
  })
  .partial();

export function registerUserTools(server: McpServer, role: "admin" | "superuser" | "user" = "admin"): void {
  server.tool(
    "get_my_profile",
    "Return the authenticated user's profile, role and permissions.",
    {},
    async () => {
      const ctx = await getAuthContext();
      const doc = await db().collection(COLLECTIONS.USERS).doc(ctx.uid).get();
      return ok({
        uid: ctx.uid,
        email: ctx.email,
        role: ctx.role,
        permissions: ctx.permissions,
        profile: doc.data() ?? null,
      });
    },
  );

  if (role !== "admin") return;

  server.tool(
    "list_users",
    "Admin-only. List users in the users collection.",
    {
      role: ROLE.optional(),
      active: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async ({ role, active, limit }) => {
      assertAdmin(await getAuthContext());
      let q: FirebaseFirestore.Query = db().collection(COLLECTIONS.USERS);
      if (role) q = q.where("role", "==", role);
      if (active !== undefined) q = q.where("active", "==", active);
      const snap = await q.limit(limit).get();
      const users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      return ok({ count: users.length, users });
    },
  );

  server.tool(
    "get_user",
    "Admin-only. Get a user by uid or email.",
    {
      uid: z.string().optional(),
      email: z.string().email().optional(),
    },
    async ({ uid, email }) => {
      assertAdmin(await getAuthContext());
      if (!uid && !email) throw new Error("Must provide uid or email");
      if (uid) {
        const doc = await db().collection(COLLECTIONS.USERS).doc(uid).get();
        if (!doc.exists) throw new Error(`User ${uid} not found`);
        return ok({ uid, ...doc.data() });
      }
      const snap = await db()
        .collection(COLLECTIONS.USERS)
        .where("email", "==", email!.toLowerCase())
        .limit(1)
        .get();
      if (snap.empty) throw new Error(`User with email ${email} not found`);
      return ok({ uid: snap.docs[0].id, ...snap.docs[0].data() });
    },
  );

  server.tool(
    "invite_user",
    "Admin-only. Create a pending invitation so that when the invitee signs in with Google, they get the pre-assigned role and permissions.",
    {
      email: z.string().email(),
      display_name: z.string().optional(),
      role: ROLE.optional().default("user"),
      permissions: PERMISSIONS_SCHEMA.optional(),
    },
    async ({ email, display_name, role, permissions }) => {
      assertAdmin(await getAuthContext());
      const lower = email.toLowerCase();
      const payload = {
        email: lower,
        displayName: display_name ?? "",
        role,
        permissions: permissions ?? {},
        status: "pending",
        processed: false,
        createdAt: Timestamp.now(),
      };
      await db().collection(COLLECTIONS.USER_INVITATIONS).doc(lower).set(payload);
      return ok(payload);
    },
  );

  server.tool(
    "list_pending_invitations",
    "Admin-only. List invitations that have not yet been claimed by a sign-in.",
    {},
    async () => {
      assertAdmin(await getAuthContext());
      const snap = await db()
        .collection(COLLECTIONS.USER_INVITATIONS)
        .where("processed", "==", false)
        .get();
      const invitations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return ok({ count: invitations.length, invitations });
    },
  );

  server.tool(
    "cancel_invitation",
    "Admin-only. Delete a pending invitation.",
    { email: z.string().email() },
    async ({ email }) => {
      assertAdmin(await getAuthContext());
      await db().collection(COLLECTIONS.USER_INVITATIONS).doc(email.toLowerCase()).delete();
      return ok({ email: email.toLowerCase(), deleted: true });
    },
  );

  server.tool(
    "update_user_role",
    "Admin-only. Update a user's role and/or permissions. For admin role, also sets the adminList entry and the Firebase Auth custom claim so Firestore rules recognize them.",
    {
      uid: z.string(),
      role: ROLE.optional(),
      permissions: PERMISSIONS_SCHEMA.optional(),
    },
    async ({ uid, role, permissions }) => {
      assertAdmin(await getAuthContext());
      const firestore = db();
      const update: Record<string, unknown> = { updatedAt: Timestamp.now() };
      if (role) update.role = role;
      if (permissions) update.permissions = permissions;
      await firestore.collection(COLLECTIONS.USERS).doc(uid).set(update, { merge: true });

      if (role === "admin") {
        await firestore
          .collection(COLLECTIONS.ADMIN_LIST)
          .doc(uid)
          .set({ addedAt: Timestamp.now() }, { merge: true });
        await admin.auth().setCustomUserClaims(uid, { admin: true });
      } else if (role) {
        await firestore.collection(COLLECTIONS.ADMIN_LIST).doc(uid).delete();
        await admin.auth().setCustomUserClaims(uid, { admin: false });
      }

      return ok({ uid, role, permissions });
    },
  );

  server.tool(
    "deactivate_user",
    "Admin-only. Mark a user inactive (soft). Does NOT disable their Firebase Auth account.",
    { uid: z.string() },
    async ({ uid }) => {
      assertAdmin(await getAuthContext());
      await db()
        .collection(COLLECTIONS.USERS)
        .doc(uid)
        .set({ active: false, updatedAt: Timestamp.now() }, { merge: true });
      return ok({ uid, active: false });
    },
  );

  server.tool(
    "reactivate_user",
    "Admin-only. Reactivate a previously deactivated user.",
    { uid: z.string() },
    async ({ uid }) => {
      assertAdmin(await getAuthContext());
      await db()
        .collection(COLLECTIONS.USERS)
        .doc(uid)
        .set({ active: true, updatedAt: Timestamp.now() }, { merge: true });
      return ok({ uid, active: true });
    },
  );
}
