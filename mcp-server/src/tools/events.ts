import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS, nptToday } from "../constants.js";
import { getAuthContext } from "../auth.js";
import { resolveTreeByTitleOrId } from "./trees.js";
import { resolveTithiToDate } from "./tithi.js";
import { ok } from "./index.js";

function normalize(s: string | undefined): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const tithiSpecSchema = z.object({
  paksha: z.string(),
  tithi_name: z.string(),
  month: z.string(),
});

export function registerEventTools(server: McpServer): void {
  server.tool(
    "list_events",
    "List calendar events visible to the user in a date range. Includes public events, events created by the user, and events attached to trees they own or share.",
    {
      start_date: z.string().regex(DATE_RE),
      end_date: z.string().regex(DATE_RE),
      tree_id: z.string().optional(),
      include_public: z.boolean().optional().default(true),
    },
    async ({ start_date, end_date, tree_id, include_public }) => {
      const ctx = await getAuthContext();
      const firestore = db();
      const buckets: Record<string, FirebaseFirestore.DocumentData & { id: string }> = {};
      const push = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
        buckets[d.id] = { id: d.id, ...d.data() };
      };

      const own = await firestore
        .collection(COLLECTIONS.CALENDAR_EVENTS)
        .where("createdBy", "==", ctx.uid)
        .where("dateKey", ">=", start_date)
        .where("dateKey", "<=", end_date)
        .get();
      own.forEach(push);

      if (include_public) {
        const pub = await firestore
          .collection(COLLECTIONS.CALENDAR_EVENTS)
          .where("isPublic", "==", true)
          .where("dateKey", ">=", start_date)
          .where("dateKey", "<=", end_date)
          .get();
        pub.forEach(push);
      }

      if (tree_id) {
        await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id });
        const tr = await firestore
          .collection(COLLECTIONS.CALENDAR_EVENTS)
          .where("treeId", "==", tree_id)
          .where("dateKey", ">=", start_date)
          .where("dateKey", "<=", end_date)
          .get();
        tr.forEach(push);
      }

      const events = Object.values(buckets).sort((a, b) =>
        String(a.dateKey).localeCompare(String(b.dateKey)),
      );
      return ok({ count: events.length, events });
    },
  );

  server.tool(
    "list_upcoming_events",
    "Convenience shortcut for events in the next N days (NPT).",
    {
      days_ahead: z.number().int().min(1).max(365).optional().default(7),
      tree_id: z.string().optional(),
    },
    async ({ days_ahead, tree_id }) => {
      const ctx = await getAuthContext();
      const firestore = db();
      const start = nptToday();
      const e = new Date(start + "T00:00:00Z");
      e.setUTCDate(e.getUTCDate() + days_ahead);
      const end = e.toISOString().slice(0, 10);

      const buckets: Record<string, FirebaseFirestore.DocumentData & { id: string }> = {};
      const own = await firestore
        .collection(COLLECTIONS.CALENDAR_EVENTS)
        .where("createdBy", "==", ctx.uid)
        .where("dateKey", ">=", start)
        .where("dateKey", "<=", end)
        .get();
      own.forEach((d) => (buckets[d.id] = { id: d.id, ...d.data() }));
      if (tree_id) {
        await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id });
        const tr = await firestore
          .collection(COLLECTIONS.CALENDAR_EVENTS)
          .where("treeId", "==", tree_id)
          .where("dateKey", ">=", start)
          .where("dateKey", "<=", end)
          .get();
        tr.forEach((d) => (buckets[d.id] = { id: d.id, ...d.data() }));
      }
      const events = Object.values(buckets).sort((a, b) =>
        String(a.dateKey).localeCompare(String(b.dateKey)),
      );
      return ok({ start, end, count: events.length, events });
    },
  );

  server.tool(
    "get_event",
    "Get a single event by id.",
    { event_id: z.string() },
    async ({ event_id }) => {
      const ctx = await getAuthContext();
      const doc = await db().collection(COLLECTIONS.CALENDAR_EVENTS).doc(event_id).get();
      if (!doc.exists) throw new Error(`Event ${event_id} not found`);
      const data = doc.data()!;
      const canSee =
        data.isPublic === true ||
        data.createdBy === ctx.uid ||
        (data.treeId && (await canAccessTree(data.treeId, ctx)));
      if (!canSee) throw new Error("Not authorized to view this event");
      return ok({ id: doc.id, ...data });
    },
  );

  server.tool(
    "create_event",
    "Create a calendar event. Either provide an AD `date` OR a `tithi` spec (paksha + tithi_name + month) for tithi-based events. Tithi events are typically yearly-recurring.",
    {
      title: z.string().min(1),
      date: z.string().regex(DATE_RE).optional(),
      tithi: tithiSpecSchema.optional(),
      description: z.string().optional(),
      repetition: z.enum(["none", "monthly", "yearly"]).optional().default("none"),
      tree_id: z.string().optional(),
      member_id: z.string().optional(),
      is_public: z.boolean().optional().default(false),
    },
    async (args) => {
      const ctx = await getAuthContext();
      if (args.is_public && ctx.role !== "admin") {
        throw new Error("Only admins can create public events");
      }
      if (!args.date && !args.tithi) {
        throw new Error("Must provide either `date` or `tithi`");
      }
      if (args.date && args.tithi) {
        throw new Error("Provide only one of `date` or `tithi`, not both");
      }
      if (args.tree_id) {
        await resolveTreeByTitleOrId(ctx.uid, ctx.email, { tree_id: args.tree_id });
      }

      let dateKey: string;
      let tithiPayload: Record<string, unknown> | null = null;

      if (args.tithi) {
        const resolved = await resolveTithiToDate(args.tithi);
        if (!resolved) {
          throw new Error(
            `Could not resolve tithi ${args.tithi.paksha} ${args.tithi.tithi_name} ${args.tithi.month} — no matching tithi found in Firestore for an upcoming BS year.`,
          );
        }
        dateKey = resolved;
        tithiPayload = {
          paksha: args.tithi.paksha,
          tithiName: args.tithi.tithi_name,
          month: args.tithi.month,
        };
      } else {
        dateKey = args.date!;
      }

      const payload = {
        title: args.title,
        titleNormalized: normalize(args.title),
        description: args.description ?? "",
        descriptionNormalized: normalize(args.description),
        dateKey,
        repetition: args.repetition ?? (args.tithi ? "yearly" : "none"),
        tithi: tithiPayload,
        isPublic: !!args.is_public,
        createdBy: ctx.uid,
        createdByAdmin: ctx.role === "admin",
        treeId: args.tree_id ?? null,
        memberId: args.member_id ?? null,
        createdAt: Timestamp.now(),
      };
      const ref = await db().collection(COLLECTIONS.CALENDAR_EVENTS).add(payload);
      return ok({ id: ref.id, ...payload });
    },
  );

  server.tool(
    "update_event",
    "Update an existing event.",
    {
      event_id: z.string(),
      title: z.string().optional(),
      date: z.string().regex(DATE_RE).optional(),
      description: z.string().optional(),
      repetition: z.enum(["none", "monthly", "yearly"]).optional(),
      tree_id: z.string().nullable().optional(),
      member_id: z.string().nullable().optional(),
    },
    async ({ event_id, date, tree_id, member_id, ...rest }) => {
      const ctx = await getAuthContext();
      const ref = db().collection(COLLECTIONS.CALENDAR_EVENTS).doc(event_id);
      const doc = await ref.get();
      if (!doc.exists) throw new Error(`Event ${event_id} not found`);
      if (doc.data()!.createdBy !== ctx.uid && ctx.role !== "admin") {
        throw new Error("Not authorized to update this event");
      }
      const update: Record<string, unknown> = {};
      if (rest.title !== undefined) {
        update.title = rest.title;
        update.titleNormalized = normalize(rest.title);
      }
      if (rest.description !== undefined) {
        update.description = rest.description;
        update.descriptionNormalized = normalize(rest.description);
      }
      if (rest.repetition !== undefined) update.repetition = rest.repetition;
      if (date !== undefined) update.dateKey = date;
      if (tree_id !== undefined) update.treeId = tree_id;
      if (member_id !== undefined) update.memberId = member_id;
      await ref.update(update);
      return ok({ id: event_id, updated: Object.keys(update) });
    },
  );

  server.tool(
    "delete_event",
    "Delete an event. Requires confirmation.",
    {
      event_id: z.string(),
      confirmation: z.literal(true),
    },
    async ({ event_id }) => {
      const ctx = await getAuthContext();
      const ref = db().collection(COLLECTIONS.CALENDAR_EVENTS).doc(event_id);
      const doc = await ref.get();
      if (!doc.exists) throw new Error(`Event ${event_id} not found`);
      if (doc.data()!.createdBy !== ctx.uid && ctx.role !== "admin") {
        throw new Error("Not authorized to delete this event");
      }
      await ref.delete();
      return ok({ id: event_id, deleted: true });
    },
  );
}

async function canAccessTree(
  treeId: string,
  ctx: { uid: string; email: string | null },
): Promise<boolean> {
  const doc = await db().collection(COLLECTIONS.TREES).doc(treeId).get();
  if (!doc.exists) return false;
  const data = doc.data()!;
  if (data.ownerUid === ctx.uid) return true;
  const shared: string[] = data.sharedWithEmails ?? [];
  return !!(ctx.email && shared.includes(ctx.email));
}
