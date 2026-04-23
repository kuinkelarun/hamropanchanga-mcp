import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS } from "../constants.js";
import { getAuthContext } from "../auth.js";
import { resolveTreeByTitleOrId } from "./trees.js";
import { ok } from "./index.js";

function normalize(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerMemberTools(server: McpServer): void {
  server.tool(
    "list_members",
    "List all members in a given family tree.",
    {
      tree_id: z.string().optional(),
      tree_title: z.string().optional(),
    },
    async (args) => {
      const ctx = await getAuthContext();
      const { id: treeId } = await resolveTreeByTitleOrId(ctx.uid, ctx.email, args);
      const snap = await db()
        .collection(COLLECTIONS.TREES)
        .doc(treeId)
        .collection(COLLECTIONS.TREE_MEMBERS)
        .get();
      const members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return ok({ tree_id: treeId, count: members.length, members });
    },
  );

  server.tool(
    "get_member",
    "Get a single member's full details.",
    {
      tree_id: z.string(),
      member_id: z.string(),
    },
    async ({ tree_id, member_id }) => {
      const ctx = await getAuthContext();
      await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id });
      const doc = await db()
        .collection(COLLECTIONS.TREES)
        .doc(tree_id)
        .collection(COLLECTIONS.TREE_MEMBERS)
        .doc(member_id)
        .get();
      if (!doc.exists) throw new Error(`Member ${member_id} not found`);
      return ok({ id: doc.id, ...doc.data() });
    },
  );

  server.tool(
    "find_member",
    "Search for members by name across the user's accessible trees.",
    {
      name_query: z.string(),
      tree_hint: z.string().optional().describe("Optional tree id or title to narrow search"),
    },
    async ({ name_query, tree_hint }) => {
      const ctx = await getAuthContext();
      const firestore = db();
      const q = normalize(name_query);

      const treeIds: string[] = [];
      if (tree_hint) {
        const { id } = await resolveTreeByTitleOrId(ctx.uid, ctx.email, {
          tree_id: tree_hint,
          tree_title: tree_hint,
        });
        treeIds.push(id);
      } else {
        const owned = await firestore
          .collection(COLLECTIONS.TREES)
          .where("ownerUid", "==", ctx.uid)
          .get();
        owned.forEach((d) => {
          if (d.data().deleted !== true) treeIds.push(d.id);
        });
        if (ctx.email) {
          const shared = await firestore
            .collection(COLLECTIONS.TREES)
            .where("sharedWithEmails", "array-contains", ctx.email)
            .get();
          shared.forEach((d) => {
            const data = d.data();
            if (data.deleted !== true && data.ownerUid !== ctx.uid) treeIds.push(d.id);
          });
        }
      }

      const matches: Array<{ tree_id: string; member: unknown }> = [];
      for (const treeId of treeIds) {
        const membersSnap = await firestore
          .collection(COLLECTIONS.TREES)
          .doc(treeId)
          .collection(COLLECTIONS.TREE_MEMBERS)
          .get();
        membersSnap.forEach((m) => {
          const data = m.data();
          const haystack = normalize(data.nameSearchable || data.name);
          if (haystack.includes(q)) {
            matches.push({ tree_id: treeId, member: { id: m.id, ...data } });
          }
        });
      }

      return ok({ query: name_query, count: matches.length, matches });
    },
  );

  server.tool(
    "add_member",
    "Add a new member to a family tree. Creates an unconnected node — use the TreeBuilder UI afterwards to connect the member to parents, spouse, or children.",
    {
      tree_id: z.string().optional(),
      tree_title: z.string().optional(),
      name: z.string().min(1),
      nickname: z.string().optional(),
      dob: z.string().optional().describe("YYYY-MM-DD (AD)"),
      dod: z.string().optional().describe("YYYY-MM-DD (AD)"),
      gender: z.enum(["male", "female", "unknown"]).optional(),
      status: z.enum(["alive", "deceased"]).optional(),
      notes: z.string().optional(),
      location: z.string().optional(),
      photo_url: z.string().optional(),
    },
    async (args) => {
      const ctx = await getAuthContext();
      const { id: treeId } = await resolveTreeByTitleOrId(ctx.uid, ctx.email, args);
      const now = Timestamp.now();
      const payload: Record<string, unknown> = {
        name: args.name,
        nameSearchable: normalize(args.name),
        nickname: args.nickname ?? "",
        dob: args.dob ?? "",
        dod: args.dod ?? "",
        gender: args.gender ?? "unknown",
        status: args.status ?? (args.dod ? "deceased" : "alive"),
        notes: args.notes ?? "",
        location: args.location ?? "",
        photo: args.photo_url ?? "",
        createdAt: now,
        updatedAt: now,
      };
      const ref = await db()
        .collection(COLLECTIONS.TREES)
        .doc(treeId)
        .collection(COLLECTIONS.TREE_MEMBERS)
        .add(payload);
      return ok({
        id: ref.id,
        tree_id: treeId,
        ...payload,
        note: "Member created as an unconnected node. Open the Tree Builder to link them into the family graph.",
      });
    },
  );

  server.tool(
    "update_member",
    "Update fields on an existing member.",
    {
      tree_id: z.string(),
      member_id: z.string(),
      name: z.string().optional(),
      nickname: z.string().optional(),
      dob: z.string().optional(),
      dod: z.string().optional(),
      gender: z.enum(["male", "female", "unknown"]).optional(),
      status: z.enum(["alive", "deceased"]).optional(),
      notes: z.string().optional(),
      location: z.string().optional(),
      photo_url: z.string().optional(),
    },
    async ({ tree_id, member_id, photo_url, ...rest }) => {
      const ctx = await getAuthContext();
      await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id });
      const update: Record<string, unknown> = { updatedAt: Timestamp.now() };
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) update[k] = v;
      }
      if (rest.name !== undefined) update.nameSearchable = normalize(rest.name);
      if (photo_url !== undefined) update.photo = photo_url;
      await db()
        .collection(COLLECTIONS.TREES)
        .doc(tree_id)
        .collection(COLLECTIONS.TREE_MEMBERS)
        .doc(member_id)
        .update(update);
      return ok({ id: member_id, tree_id, updated: Object.keys(update) });
    },
  );

  server.tool(
    "remove_member",
    "Delete a member. Any relationships involving this member are cleaned up by the Firestore-side cascade. Requires confirmation.",
    {
      tree_id: z.string(),
      member_id: z.string(),
      confirmation: z.literal(true).describe("Must be true to confirm destructive action"),
    },
    async ({ tree_id, member_id }) => {
      const ctx = await getAuthContext();
      await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id });
      const firestore = db();
      const batch = firestore.batch();
      const memberRef = firestore
        .collection(COLLECTIONS.TREES)
        .doc(tree_id)
        .collection(COLLECTIONS.TREE_MEMBERS)
        .doc(member_id);
      batch.delete(memberRef);

      const relsSnap = await firestore
        .collection(COLLECTIONS.TREES)
        .doc(tree_id)
        .collection(COLLECTIONS.TREE_RELATIONSHIPS)
        .get();
      relsSnap.forEach((r) => {
        const data = r.data();
        if (data.fromMemberId === member_id || data.toMemberId === member_id) {
          batch.delete(r.ref);
        }
      });

      await batch.commit();
      return ok({ id: member_id, tree_id, deleted: true });
    },
  );

  // Silence unused-import warning for FieldValue; kept for future tools that use sentinels.
  void FieldValue;
}
