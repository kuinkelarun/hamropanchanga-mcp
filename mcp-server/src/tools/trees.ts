import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS } from "../constants.js";
import { getAuthContext } from "../auth.js";
import { ok } from "./index.js";

interface TreeSummary {
  id: string;
  title: string;
  contact?: string;
  location?: string;
  primaryMemberName?: string;
  ownerEmail?: string;
  source: "owned" | "shared";
}

export async function resolveTreeByTitleOrId(
  uid: string,
  email: string | null,
  treeRef: { tree_id?: string; tree_title?: string },
): Promise<{ id: string; data: FirebaseFirestore.DocumentData }> {
  const firestore = db();
  if (treeRef.tree_id) {
    const doc = await firestore.collection(COLLECTIONS.TREES).doc(treeRef.tree_id).get();
    if (!doc.exists) throw new Error(`Tree ${treeRef.tree_id} not found`);
    const data = doc.data()!;
    assertCanAccessTree(data, uid, email);
    return { id: doc.id, data };
  }
  if (treeRef.tree_title) {
    const trees = await listAccessibleTrees(uid, email);
    const match = trees.find(
      (t) => t.title?.toLowerCase() === treeRef.tree_title!.toLowerCase(),
    );
    if (!match) throw new Error(`No accessible tree titled "${treeRef.tree_title}"`);
    return { id: match.id, data: match };
  }
  throw new Error("Must provide tree_id or tree_title");
}

function assertCanAccessTree(
  tree: FirebaseFirestore.DocumentData,
  uid: string,
  email: string | null,
): void {
  if (tree.ownerUid === uid) return;
  const shared: string[] = tree.sharedWithEmails ?? [];
  if (email && shared.includes(email)) return;
  throw new Error("Not authorized to access this tree");
}

async function listAccessibleTrees(
  uid: string,
  email: string | null,
): Promise<Array<FirebaseFirestore.DocumentData & { id: string }>> {
  const firestore = db();
  const out: Array<FirebaseFirestore.DocumentData & { id: string }> = [];

  const owned = await firestore
    .collection(COLLECTIONS.TREES)
    .where("ownerUid", "==", uid)
    .get();
  owned.forEach((d) => {
    const data = d.data();
    if (data.deleted !== true) out.push({ id: d.id, ...data });
  });

  if (email) {
    const shared = await firestore
      .collection(COLLECTIONS.TREES)
      .where("sharedWithEmails", "array-contains", email)
      .get();
    shared.forEach((d) => {
      const data = d.data();
      if (data.deleted === true) return;
      if (data.ownerUid === uid) return;
      out.push({ id: d.id, ...data });
    });
  }

  return out;
}

export function registerTreeTools(server: McpServer): void {
  server.tool(
    "create_tree",
    "Create a new family tree owned by the authenticated user. After the tree is created, always call add_member with the primary_member_name to add them to the tree — ask the user for any additional member details (gender, date of birth, etc.) before doing so.",
    {
      title: z.string().describe("Name/title of the new family tree"),
      contact: z.string().describe("Contact information for the tree (phone/email)"),
      location: z.string().describe("Geographic location associated with the tree"),
      primary_member_name: z.string().describe("Name of the primary member"),
    },
    async ({ title, contact, location, primary_member_name }) => {
      const ctx = await getAuthContext();
      const firestore = db();
      const now = Timestamp.now();
      const docData: Record<string, unknown> = {
        title,
        ownerUid: ctx.uid,
        ownerEmail: ctx.email ?? null,
        contact,
        location,
        primaryMemberName: primary_member_name,
        sharedWith: {},
        sharedWithEmails: [],
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };

      const ref = await firestore.collection(COLLECTIONS.TREES).add(docData);
      return ok({ id: ref.id, title, ownerUid: ctx.uid, ownerEmail: ctx.email ?? null, primary_member_name });
    },
  );

  server.tool(
    "list_trees",
    "List family trees the authenticated user owns or has been granted access to (via sharedWithEmails). Returns tree metadata and source flag.",
    {
      include_shared: z.boolean().optional().default(true),
    },
    async ({ include_shared }) => {
      const ctx = await getAuthContext();
      const firestore = db();
      const trees: TreeSummary[] = [];

      const owned = await firestore
        .collection(COLLECTIONS.TREES)
        .where("ownerUid", "==", ctx.uid)
        .get();
      owned.forEach((d) => {
        const data = d.data();
        if (data.deleted === true) return;
        trees.push({
          id: d.id,
          title: data.title,
          contact: data.contact,
          location: data.location,
          primaryMemberName: data.primaryMemberName,
          ownerEmail: data.ownerEmail,
          source: "owned",
        });
      });

      if (include_shared && ctx.email) {
        const shared = await firestore
          .collection(COLLECTIONS.TREES)
          .where("sharedWithEmails", "array-contains", ctx.email)
          .get();
        shared.forEach((d) => {
          const data = d.data();
          if (data.deleted === true) return;
          if (data.ownerUid === ctx.uid) return;
          trees.push({
            id: d.id,
            title: data.title,
            contact: data.contact,
            location: data.location,
            primaryMemberName: data.primaryMemberName,
            ownerEmail: data.ownerEmail,
            source: "shared",
          });
        });
      }

      return ok({ count: trees.length, trees });
    },
  );

  server.tool(
    "get_tree",
    "Get full details of a single family tree by id or title.",
    {
      tree_id: z.string().optional(),
      tree_title: z.string().optional(),
    },
    async (args) => {
      const ctx = await getAuthContext();
      const { id, data } = await resolveTreeByTitleOrId(ctx.uid, ctx.email, args);
      return ok({ id, ...data });
    },
  );
}
