import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../firebase.js";
import {
  COLLECTIONS,
  BS_MONTHS_EN,
  BS_MONTHS_NE,
  addDays,
  daysBetween,
  nptToday,
} from "../constants.js";
import { ok } from "./index.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface BsYearDoc {
  startAdDate: string;
  daysInMonths: number[];
}

async function loadBsYear(bsYear: number): Promise<BsYearDoc> {
  const doc = await db()
    .collection(COLLECTIONS.NEPALI_CALENDAR_YEARS)
    .doc(String(bsYear))
    .get();
  if (!doc.exists) {
    throw new Error(`No calendar data for BS year ${bsYear}`);
  }
  const data = doc.data() as BsYearDoc;
  if (!data.startAdDate || !Array.isArray(data.daysInMonths)) {
    throw new Error(`Malformed calendar data for BS year ${bsYear}`);
  }
  return data;
}

export async function bsToAd(
  bsYear: number,
  bsMonth: number,
  bsDay: number,
): Promise<string> {
  const { startAdDate, daysInMonths } = await loadBsYear(bsYear);
  if (bsMonth < 1 || bsMonth > daysInMonths.length) {
    throw new Error(`Invalid BS month ${bsMonth} for year ${bsYear}`);
  }
  if (bsDay < 1 || bsDay > daysInMonths[bsMonth - 1]) {
    throw new Error(
      `Invalid BS day ${bsDay} for month ${bsMonth}/${bsYear} (has ${daysInMonths[bsMonth - 1]} days)`,
    );
  }
  let offset = bsDay - 1;
  for (let i = 0; i < bsMonth - 1; i++) offset += daysInMonths[i];
  return addDays(startAdDate, offset);
}

export async function adToBs(adDate: string): Promise<{
  bsYear: number;
  bsMonth: number;
  bsDay: number;
  bsMonthName: string;
  bsMonthNameNe: string;
}> {
  const adYear = parseInt(adDate.slice(0, 4), 10);
  const candidates = [adYear + 56, adYear + 57, adYear + 58];
  for (const bsYear of candidates) {
    try {
      const { startAdDate, daysInMonths } = await loadBsYear(bsYear);
      const diff = daysBetween(startAdDate, adDate);
      if (diff < 0) continue;
      const total = daysInMonths.reduce((s, n) => s + n, 0);
      if (diff >= total) continue;
      let rem = diff;
      for (let i = 0; i < daysInMonths.length; i++) {
        if (rem < daysInMonths[i]) {
          return {
            bsYear,
            bsMonth: i + 1,
            bsDay: rem + 1,
            bsMonthName: BS_MONTHS_EN[i] ?? "",
            bsMonthNameNe: BS_MONTHS_NE[i] ?? "",
          };
        }
        rem -= daysInMonths[i];
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Could not convert ${adDate} — BS year data not loaded`);
}

export function registerCalendarTools(server: McpServer): void {
  server.tool(
    "convert_ad_to_bs",
    "Convert an AD (Gregorian) date to BS (Bikram Sambat / Nepali) date using calendar data in Firestore.",
    { date: z.string().regex(DATE_RE) },
    async ({ date }) => ok(await adToBs(date)),
  );

  server.tool(
    "convert_bs_to_ad",
    "Convert a BS (Nepali) date to AD (Gregorian) date.",
    {
      bs_year: z.number().int(),
      bs_month: z.number().int().min(1).max(12),
      bs_day: z.number().int().min(1).max(32),
    },
    async ({ bs_year, bs_month, bs_day }) => {
      const ad = await bsToAd(bs_year, bs_month, bs_day);
      return ok({ bs_year, bs_month, bs_day, ad_date: ad });
    },
  );

  server.tool(
    "convert_batch",
    "Convert multiple dates in one call. Each item is either {ad_date} or {bs_year, bs_month, bs_day}. Max 100.",
    {
      items: z
        .array(
          z.union([
            z.object({ ad_date: z.string().regex(DATE_RE) }),
            z.object({
              bs_year: z.number().int(),
              bs_month: z.number().int().min(1).max(12),
              bs_day: z.number().int().min(1).max(32),
            }),
          ]),
        )
        .max(100),
    },
    async ({ items }) => {
      const results = [];
      for (const item of items) {
        try {
          if ("ad_date" in item) {
            results.push({ input: item, ...(await adToBs(item.ad_date)) });
          } else {
            results.push({
              input: item,
              ad_date: await bsToAd(item.bs_year, item.bs_month, item.bs_day),
            });
          }
        } catch (err) {
          results.push({ input: item, error: (err as Error).message });
        }
      }
      return ok({ count: results.length, results });
    },
  );

  server.tool(
    "get_today",
    "Get today's date in Nepal Time — both AD and BS.",
    {},
    async () => {
      const ad = nptToday();
      const bs = await adToBs(ad);
      return ok({ ad_date: ad, ...bs });
    },
  );
}
