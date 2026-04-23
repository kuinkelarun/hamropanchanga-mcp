import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../firebase.js";
import { COLLECTIONS, nptToday } from "../constants.js";
import { getAuthContext, assertAdmin } from "../auth.js";
import { ok } from "./index.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function resolveTithiToDate(
  spec: { paksha: string; tithi_name: string; month: string },
  fromDate?: string,
): Promise<string | null> {
  const startFrom = fromDate ?? nptToday();
  const snap = await db()
    .collection(COLLECTIONS.TITHIS)
    .where("tithiName", "==", spec.tithi_name)
    .get();
  const candidates = snap.docs
    .map((d) => d.data() as { pakshya?: string; tithiMonth?: string; startDate?: string })
    .filter(
      (t) =>
        t.pakshya === spec.paksha &&
        t.tithiMonth === spec.month &&
        typeof t.startDate === "string" &&
        t.startDate >= startFrom,
    )
    .sort((a, b) => (a.startDate! < b.startDate! ? -1 : 1));
  return candidates[0]?.startDate ?? null;
}

export function registerTithiTools(server: McpServer): void {
  server.tool(
    "get_tithi_today",
    "Get the tithi(s) active right now in Nepal Time (Asia/Kathmandu).",
    {},
    async () => getTithisOn(nptToday()),
  );

  server.tool(
    "get_tithi_for_date",
    "Get the tithi(s) active on a specific AD date.",
    { date: z.string().regex(DATE_RE) },
    async ({ date }) => getTithisOn(date),
  );

  server.tool(
    "list_tithis_in_range",
    "List tithis whose start date falls in the AD range (max 366 days).",
    {
      start_date: z.string().regex(DATE_RE),
      end_date: z.string().regex(DATE_RE),
    },
    async ({ start_date, end_date }) => {
      if (end_date < start_date) throw new Error("end_date must be >= start_date");
      const days = Math.floor(
        (Date.parse(end_date) - Date.parse(start_date)) / 86400000,
      );
      if (days > 366) throw new Error("Range cannot exceed 366 days");
      const snap = await db()
        .collection(COLLECTIONS.TITHIS)
        .where("startDate", ">=", start_date)
        .where("startDate", "<=", end_date)
        .orderBy("startDate", "asc")
        .get();
      const tithis = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      return ok({ start_date, end_date, count: tithis.length, tithis });
    },
  );

  server.tool(
    "resolve_tithi_event_date",
    "Resolve a tithi spec (paksha + tithi name + lunar month) to the next occurrence's AD date. Use Nepali Devanagari strings for paksha/tithi_name/month (e.g. शुक्लपक्ष / प्रतिपदा / वैशाख).",
    {
      paksha: z.string(),
      tithi_name: z.string(),
      month: z.string(),
      from_date: z.string().regex(DATE_RE).optional(),
    },
    async ({ paksha, tithi_name, month, from_date }) => {
      const date = await resolveTithiToDate({ paksha, tithi_name, month }, from_date);
      if (!date) {
        return ok({
          resolved: false,
          message: `No upcoming tithi found matching ${paksha} / ${tithi_name} / ${month}. The BS year may not have tithis generated yet.`,
        });
      }
      return ok({ resolved: true, ad_date: date });
    },
  );

  server.tool(
    "find_next_tithi",
    "Find the next occurrence(s) of a named tithi (e.g. Purnima, Ekadashi) after a given date.",
    {
      tithi_name: z.string(),
      paksha: z.string().optional(),
      from_date: z.string().regex(DATE_RE).optional(),
      limit: z.number().int().min(1).max(24).optional().default(1),
    },
    async ({ tithi_name, paksha, from_date, limit }) => {
      const startFrom = from_date ?? nptToday();
      const snap = await db()
        .collection(COLLECTIONS.TITHIS)
        .where("tithiName", "==", tithi_name)
        .get();
      const matches = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }) as { id: string; pakshya?: string; startDate?: string })
        .filter(
          (t) =>
            typeof t.startDate === "string" &&
            t.startDate >= startFrom &&
            (!paksha || t.pakshya === paksha),
        )
        .sort((a, b) => (a.startDate! < b.startDate! ? -1 : 1))
        .slice(0, limit);
      return ok({ count: matches.length, tithis: matches });
    },
  );

  server.tool(
    "update_tithi",
    "Admin-only. Update fields on a tithi doc.",
    {
      tithi_id: z.string(),
      name: z.string().optional(),
      category: z.string().optional(),
      startDate: z.string().regex(DATE_RE).optional(),
      endDate: z.string().regex(DATE_RE).optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
    },
    async ({ tithi_id, ...fields }) => {
      assertAdmin(await getAuthContext());
      const update: Record<string, unknown> = { updatedAt: Timestamp.now() };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) update[k] = v;
      }
      await db().collection(COLLECTIONS.TITHIS).doc(tithi_id).update(update);
      return ok({ id: tithi_id, updated: Object.keys(update) });
    },
  );

  server.tool(
    "delete_tithi",
    "Admin-only. Delete a tithi doc.",
    {
      tithi_id: z.string(),
      confirmation: z.literal(true),
    },
    async ({ tithi_id }) => {
      assertAdmin(await getAuthContext());
      await db().collection(COLLECTIONS.TITHIS).doc(tithi_id).delete();
      return ok({ id: tithi_id, deleted: true });
    },
  );

  server.tool(
    "generate_tithis",
    "Admin-only. NOT YET IMPLEMENTED in MCP. Tithi generation relies on the Python Skyfield `computeEphemeris` Cloud Function. Trigger generation from the React admin UI (AdminTithiGeneratorSection) for now; a future revision will invoke the callable from here.",
    {
      start_date: z.string().regex(DATE_RE),
      end_date: z.string().regex(DATE_RE),
    },
    async () => {
      assertAdmin(await getAuthContext());
      return ok({
        implemented: false,
        reason:
          "computeEphemeris callable cannot be invoked from Admin SDK without a user ID token. Use the React admin UI until we expose an HTTPS-triggered variant.",
      });
    },
  );
}

async function getTithisOn(date: string) {
  const snap = await db()
    .collection(COLLECTIONS.TITHIS)
    .where("startDate", "<=", date)
    .orderBy("startDate", "desc")
    .limit(10)
    .get();
  const active = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t: any) => (t.endDate ?? t.startDate) >= date);
  return ok({ date, count: active.length, tithis: active });
}
