export const COLLECTIONS = {
  USERS: "users",
  ADMIN_LIST: "adminList",
  USER_INVITATIONS: "userInvitations",
  TREES: "trees",
  TREE_MEMBERS: "members",
  TREE_RELATIONSHIPS: "relationships",
  TREE_MARRIAGE_POINTS: "marriagePoints",
  CALENDAR_EVENTS: "calendarEvents",
  TITHIS: "tithis",
  NEPALI_CALENDAR_YEARS: "nepaliCalendarYears",
  API_KEY_REQUESTS: "apiKeyRequests",
  API_KEYS: "apiKeys",
  SITE_SETTINGS: "siteSettings",
  OAUTH_CLIENTS: "oauthClients",
  OAUTH_CODES: "oauthCodes",
  OAUTH_TOKENS: "oauthTokens",
} as const;

export const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

export function nptToday(): string {
  return new Date(Date.now() + NPT_OFFSET_MS).toISOString().slice(0, 10);
}

export const BS_MONTHS_NE = [
  "वैशाख", "जेष्ठ", "आषाढ", "श्रावण", "भाद्र", "आश्विन",
  "कार्तिक", "मंसिर", "पौष", "माघ", "फाल्गुन", "चैत्र",
];

export const BS_MONTHS_EN = [
  "Baishakh", "Jestha", "Ashadh", "Shrawan", "Bhadra", "Ashwin",
  "Kartik", "Mangsir", "Poush", "Magh", "Falgun", "Chaitra",
];

export const PAKSHA_NE = { SHUKLA: "शुक्लपक्ष", KRISHNA: "कृष्णपक्ष" } as const;

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00Z").getTime();
  const b = new Date(toIso + "T00:00:00Z").getTime();
  return Math.floor((b - a) / 86400000);
}
