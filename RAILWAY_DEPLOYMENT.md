# Railway Deployment Guide — HamroPanchanga MCP

This guide walks through deploying the MCP server + chat backend to **Railway** so the HamroPanchanga React app (hosted on Firebase) can call `/api/chat` in production.

> **Scope:** phase 1 of the planning doc — a single Railway service that runs the chat backend (`mcp-client`), which spawns the MCP server (`mcp-server`) as a stdio subprocess. The separate HTTP-transport MCP server (phase 3, for external Claude.ai) is noted at the bottom.

---

## 1. What gets deployed

```
┌─────────────────────────────────────────────┐
│ Railway service: hamropanchanga-chat        │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │ mcp-client (chat-backend)             │  │
│  │  - Express @ :$PORT                   │  │
│  │  - /api/chat, /api/llm-config, /health│  │
│  │  - Spawns ⬇ over stdio                │  │
│  └────────────────┬──────────────────────┘  │
│                   │                         │
│  ┌────────────────▼──────────────────────┐  │
│  │ mcp-server (child process)            │  │
│  │  - Firestore tools via Admin SDK      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
               ▲
               │ HTTPS (Firebase ID token)
               │
┌──────────────┴──────────────────────────────┐
│ React app on Firebase Hosting               │
│  REACT_APP_CHAT_BACKEND_URL = <railway-url> │
└─────────────────────────────────────────────┘
```

---

## 2. Prerequisites

- Railway account + CLI (`npm i -g @railway/cli`), OR GitHub access (Railway can deploy from a repo).
- Git repository for `hamropanchanga-mcp/` — Railway needs either a repo URL or a local project linked via CLI.
- **Firebase service-account JSON key** — Console → Project Settings → Service accounts → *Generate new private key*.
- **Anthropic API key** _or_ AWS credentials + Bedrock model access (for phase-1 shared key; per-user keys come later).
- Your Firebase project ID (`hamropanchanga`) and the named database ID (`hamropanchanga-db`).
- Firebase Hosting domain that will call the backend (e.g. `https://hamropanchanga.web.app`) — needed for CORS.

---

## 3. One-time code prep before first deploy

Good news — CORS middleware, the Firebase Admin init for the chat backend, and the `/api/llm-config` endpoints are **already wired in** (`mcp-client/src/index.ts`, `firebase.ts`, `encryption.ts`, `llm-config-store.ts`, `llm-config-routes.ts`). The only thing to do here is make sure the `Dockerfile` + `.dockerignore` are at the repo root. See §5 below.

Generate the encryption key once (see §4.6) before your first deploy — the backend will refuse to save any config without it.

---

## 4. Environment variables

Set all of these in the Railway service's **Variables** tab. Group them mentally:

### 4.1 Firebase (required)

| Variable | Value | Notes |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `hamropanchanga` | |
| `FIREBASE_DATABASE_ID` | `hamropanchanga-db` | Named Firestore database — do **not** use `(default)`. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | *Paste the entire JSON* | Railway's UI accepts multi-line values. This is read by `mcp-server/src/firebase.ts`. |

### 4.2 LLM provider mode — per-user (default) vs env fallback

The backend is **per-user-keys by default**: each signed-in user configures their own provider + credentials via `/api/llm-config`, which the React app exposes at `/settings/llm`. There is no global LLM API key required to deploy.

To bootstrap before the settings UI is in users' hands, you can enable an env-var fallback:

| Variable | Value | Notes |
|---|---|---|
| `LLM_CONFIG_FALLBACK_ENV` | `true` / *unset* | When `true`, `/api/chat` falls back to the env credentials below if the signed-in user has no per-user config. Leave unset in production once real users have set up their keys. |

**Env fallback — Anthropic direct** (only used when `LLM_CONFIG_FALLBACK_ENV=true`):

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `anthropic` |
| `ANTHROPIC_API_KEY` | `sk-ant-…` |
| `ANTHROPIC_MODEL` | `claude-opus-4-7` |

**Env fallback — AWS Bedrock** (only used when `LLM_CONFIG_FALLBACK_ENV=true`):

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `bedrock` |
| `AWS_REGION` | `us-east-1` (or your enabled region) |
| `BEDROCK_MODEL` | e.g. `anthropic.claude-opus-4-v1:0` |
| `AWS_ACCESS_KEY_ID` | *IAM user with Bedrock invoke permission* |
| `AWS_SECRET_ACCESS_KEY` | |
| `AWS_SESSION_TOKEN` | *Only for STS temp creds* |

### 4.3 MCP subprocess paths (required)

| Variable | Value | Notes |
|---|---|---|
| `MCP_SERVER_COMMAND` | `node` | |
| `MCP_SERVER_ARGS` | `/app/mcp-server/dist/index.js` | Absolute path inside the container. |

### 4.4 Auth + CORS (required)

| Variable | Value | Notes |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://hamropanchanga.web.app,https://<custom-domain>` | Comma-separated. Leave empty during early testing to allow any origin. |
| `DEV_PASSTHROUGH_UID` | *Leave unset in production* | If set, the backend skips Firebase ID-token verification and treats every request as this uid — **only for local dev or controlled staging**. |

### 4.5 Encryption key for stored user credentials (required)

The chat backend encrypts every per-user LLM secret with AES-256-GCM before writing to Firestore. You must provide a 32-byte key, base64-encoded.

| Variable | Value | Notes |
|---|---|---|
| `LLM_CONFIG_ENC_KEY` | 32 random bytes, base64 | Generate **once** with:<br>`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`<br>Store it in Google Secret Manager (see §4.7); paste the value into Railway. **Rotating this key invalidates every stored config** — users would need to re-enter their keys. |

### 4.6 Node / Railway (optional)

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | *(auto-set by Railway)* | Don't override — Railway injects this. The code already reads `process.env.PORT`. |

### 4.7 Google Secret Manager (recommended)

The two sensitive values — `LLM_CONFIG_ENC_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` — should live in Google Secret Manager as the system of record, with Railway holding copies as plain env vars. This gives you audit history and rotation semantics in GCP while keeping the runtime dead simple (Railway reads `process.env`, no SDK wiring).

There are two ways to connect the two systems:

- **Simple path (recommended, walked through below):** store the values in Secret Manager; copy-paste them into Railway variables at deploy time. No code changes.
- **Fully automated path:** have the backend fetch secrets from Secret Manager at boot. Requires `@google-cloud/secret-manager` in `mcp-client/package.json`, a GCP service account with `roles/secretmanager.secretAccessor` mounted into Railway via `GOOGLE_APPLICATION_CREDENTIALS_JSON`, and a loader that resolves both secrets before `initFirebase()` runs. Skip this for MVP — the simple path has the same blast radius (Railway already holds everything once the app boots) and a much smaller surface area.

#### 4.7.1 Secrets and where they end up

| GCP Secret Manager name | Railway env var | Consumed by |
|---|---|---|
| `hamropanchanga-llm-enc-key` | `LLM_CONFIG_ENC_KEY` | `mcp-client/src/encryption.ts` — AES-256-GCM key for per-user LLM credentials. |
| `hamropanchanga-firebase-sa` | `FIREBASE_SERVICE_ACCOUNT_JSON` | `mcp-server/src/firebase.ts` + `mcp-client/src/firebase.ts` — Firebase Admin SDK credential. |

#### 4.7.2 Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`).
- Active project set: `gcloud config set project hamropanchanga`.
- Your user (or a service account you're impersonating) has `roles/secretmanager.admin` on the project.

Enable the API once per project:

```bash
gcloud services enable secretmanager.googleapis.com
```

#### 4.7.3 Store `LLM_CONFIG_ENC_KEY`

Generate a fresh 32-byte base64 key **once** (not per deploy — rotating this key invalidates every saved per-user LLM config):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Create the secret and add the value as the first version:

```bash
gcloud secrets create hamropanchanga-llm-enc-key \
  --replication-policy=automatic

# Use echo -n so no trailing newline sneaks in — with a newline the value
# decodes to 33 bytes and encryption.ts throws "must decode to 32 bytes".
echo -n "PASTE_THE_BASE64_KEY_HERE" | \
  gcloud secrets versions add hamropanchanga-llm-enc-key --data-file=-
```

> **Pitfall:** `echo "key"` (without `-n`) appends `\n` to the stored value. The backend's `encryption.ts` base64-decodes and hard-checks exactly 32 bytes — an extra newline becomes 33 and the service refuses to boot. If you used plain `echo`, add a new version with `echo -n` and point Railway at the fixed version.

#### 4.7.4 Store `FIREBASE_SERVICE_ACCOUNT_JSON`

Download a service-account key for the `hamropanchanga` Firebase project (Console → Project Settings → Service accounts → *Generate new private key*). Assume it saved to `~/Downloads/hamropanchanga-sa.json`.

```bash
gcloud secrets create hamropanchanga-firebase-sa \
  --replication-policy=automatic

gcloud secrets versions add hamropanchanga-firebase-sa \
  --data-file="$HOME/Downloads/hamropanchanga-sa.json"

# Delete the local copy once the secret is stored — it's a long-lived
# credential and shouldn't linger on disk.
rm "$HOME/Downloads/hamropanchanga-sa.json"
```

The JSON shape is preserved verbatim; `firebase.ts` does `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!)`.

#### 4.7.5 Pull values out and paste into Railway

At deploy time (or when rotating), print each secret and paste into the matching Railway variable under **Service → Variables**:

```bash
# Copy the output and paste as Railway env var: LLM_CONFIG_ENC_KEY
gcloud secrets versions access latest --secret=hamropanchanga-llm-enc-key

# Copy the output and paste as Railway env var: FIREBASE_SERVICE_ACCOUNT_JSON
# Railway's UI accepts multi-line values — paste the full JSON including braces.
gcloud secrets versions access latest --secret=hamropanchanga-firebase-sa
```

While you're in the Variables tab, also set the non-sensitive companions:

```
FIREBASE_PROJECT_ID=hamropanchanga
FIREBASE_DATABASE_ID=hamropanchanga-db
```

Redeploy (Railway auto-redeploys on variable change).

#### 4.7.6 Verify

```bash
curl https://<railway-url>/health
# Expected:
# {"status":"ok","tools":["list_trees",…],"fallbackEnvEnabled":false}
```

If `/health` 500s or the container loops on restart, the first 20 lines of the **Deploy logs** tab almost always name the culprit:
- `LLM_CONFIG_ENC_KEY must decode to 32 bytes` → you copied the key with a trailing newline. Redo §4.7.3 with `echo -n`.
- `FirebaseError: ... invalid_grant` or `PERMISSION_DENIED` → the service-account JSON is truncated or from the wrong project. Redo §4.7.4.

#### 4.7.7 Rotation

- **`hamropanchanga-firebase-sa`** — safe to rotate any time. Generate a new key in the Firebase console, `gcloud secrets versions add` a new version, repaste into Railway, redeploy. Then revoke the old key in the Firebase console.
- **`hamropanchanga-llm-enc-key`** — **destructive**. Every `userLlmConfigs/{uid}` document is encrypted with the current key; rotating it makes all existing ciphertexts unreadable and every user has to re-enter their Anthropic / Bedrock credentials on `/settings/llm`. Only rotate on suspected compromise. If you do, post a banner in the UI before swapping the env var.

#### 4.7.8 Why Simple path is good enough

- **Audit trail:** `gcloud secrets versions list hamropanchanga-llm-enc-key` shows every value ever stored and who added it. You lose nothing by not fetching at runtime.
- **Blast radius:** both paths require the value to sit in Railway env memory while the container runs. The only difference is *how* it got there — a human paste vs. an API call with cached credentials. Fewer moving parts wins.
- **Zero code change:** `encryption.ts` and `firebase.ts` already read `process.env`. No new dependency, no new failure mode at boot.

---

## 5. Dockerfile (build both packages in one image)

Railway's Nixpacks builder doesn't play nicely with this monorepo layout because the chat backend depends on a built artifact from a sibling package. A Dockerfile is cleaner.

Save as `hamropanchanga-mcp/Dockerfile`:

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY mcp-server/package*.json ./mcp-server/
COPY mcp-client/package*.json ./mcp-client/

RUN cd mcp-server && npm ci
RUN cd mcp-client && npm ci --include=optional

COPY mcp-server ./mcp-server
COPY mcp-client ./mcp-client

RUN cd mcp-server && npm run build
RUN cd mcp-client && npm run build

# ---- runtime stage ----
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/mcp-server/package*.json ./mcp-server/
COPY --from=builder /app/mcp-server/dist ./mcp-server/dist
COPY --from=builder /app/mcp-client/package*.json ./mcp-client/
COPY --from=builder /app/mcp-client/dist ./mcp-client/dist

RUN cd mcp-server && npm ci --omit=dev
RUN cd mcp-client && npm ci --omit=dev --include=optional

WORKDIR /app/mcp-client

ENV NODE_ENV=production
ENV MCP_SERVER_COMMAND=node
ENV MCP_SERVER_ARGS=/app/mcp-server/dist/index.js

EXPOSE 3001
CMD ["node", "dist/index.js"]
```

Save as `hamropanchanga-mcp/.dockerignore`:

```
**/node_modules
**/dist
**/.env
**/.env.*
**/npm-debug.log
.git
.gitignore
README.md
RAILWAY_DEPLOYMENT.md
CHAT_UI_PLAN.md
```

---

## 6. Deploy — step by step

### Option A: GitHub repo → Railway (recommended)

1. Push `hamropanchanga-mcp/` to a GitHub repo (or keep it as a subdir of an existing repo — set **Root Directory** in Railway to `hamropanchanga-mcp`).
2. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick the repo.
3. Once the service is created, open **Settings**:
   - **Root Directory:** `hamropanchanga-mcp` (omit if the repo root is already the mcp folder).
   - **Builder:** *Dockerfile* (auto-detected if the Dockerfile is present).
4. Open **Variables** and paste everything from §4.
5. Open **Settings → Networking** → **Generate Domain**. Note the URL (e.g. `hamropanchanga-chat-production.up.railway.app`).
6. Trigger a deploy (Railway does this automatically on first setup). Watch the build log for:
   ```
   [chat-backend] MCP connected (34 tools); LLM provider=anthropic model=claude-opus-4-7
   [chat-backend] listening on http://localhost:<PORT>
   ```

### Option B: Railway CLI (local deploy)

```bash
cd C:\private\test-claude-code\hamropanchanga-mcp
railway login
railway init     # creates a new project
railway up       # uploads + builds the Dockerfile
```

Set variables either via UI or `railway variables set KEY=value`. Generate a public domain via the dashboard.

---

## 7. Verify the deploy

From your laptop, replace `$BACKEND` with the Railway URL and `$ID_TOKEN` with a Firebase ID token. Easiest way to grab the token: open the React app's DevTools console while signed in and run `await firebase.auth().currentUser.getIdToken()`.

```bash
# 1. Health (no auth)
curl https://$BACKEND/health
# Expected:
# {"status":"ok","tools":["list_trees",…],"fallbackEnvEnabled":false}

# 2. LLM config — should return unconfigured on a fresh account
curl https://$BACKEND/api/llm-config \
  -H "Authorization: Bearer $ID_TOKEN"
# Expected:
# {"configured":false}

# 3. Save an Anthropic key
curl -X PUT https://$BACKEND/api/llm-config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -d '{"provider":"anthropic","anthropic":{"apiKey":"sk-ant-...","model":"claude-opus-4-7"}}'
# Expected:
# {"configured":true,"provider":"anthropic","anthropic":{"model":"claude-opus-4-7","apiKeyLast4":"…"}}

# 4. Verify the key actually works
curl -X POST https://$BACKEND/api/llm-config/test \
  -H "Authorization: Bearer $ID_TOKEN"
# Expected:
# {"ok":true,"provider":"anthropic","model":"claude-opus-4-7"}

# 5. Chat
curl -X POST https://$BACKEND/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ID_TOKEN" \
  -d '{"messages":[{"role":"user","content":"What tithi is today?"}]}'
```

A `409 llm_not_configured` on step 5 means step 3 didn't land — check Firestore `userLlmConfigs/{uid}` for the doc.

If `/health` shows fewer than expected tools, check the **Deploy logs** tab.

---

## 8. Connect the React app

### 8.1 Lock down the `userLlmConfigs` collection in `firestore.rules`

**Before deploying the React app**, add a deny rule so the browser client can never read or write the collection that stores encrypted LLM credentials. The chat backend uses the Firebase **Admin SDK**, which bypasses security rules, so it is unaffected.

Add this block to `firestore.rules` in the React app repo (inside `service cloud.firestore { match /databases/{database}/documents { … } }`):

```
match /userLlmConfigs/{uid} {
  allow read, write: if false;
}
```

Then deploy the rules:

```bash
cd family-tree-app
firebase deploy --only firestore:rules
```

Without this rule, a signed-in user could read another user's encrypted ciphertext from the browser. Even though the values are encrypted with `LLM_CONFIG_ENC_KEY` (which lives only in the backend), defence-in-depth: keep the collection closed to all client access.

### 8.2 Point the React build at the Railway backend

Add one env var to the Firebase-hosted React app's build environment. In CRA this is a build-time var — set it where you run `npm run build`:

```bash
REACT_APP_CHAT_BACKEND_URL=https://hamropanchanga-chat-production.up.railway.app
```

Then rebuild and deploy to Firebase Hosting:

```bash
cd family-tree-app
REACT_APP_CHAT_BACKEND_URL=https://… npm run build
firebase deploy --only hosting
```

The React `chatBackendService.js` already reads this variable and falls back to `http://localhost:3001` if unset.

### 8.3 User flow after deploy

- User signs in → clicks the profile avatar → **AI Provider** menu item (or clicks **Configure now** from the chat prompt).
- Enters Anthropic key or Bedrock credentials at `/settings/llm`; hits **Test connection** to verify.
- Opens the floating chat (bottom-right) or the dedicated `/chat` page and starts chatting.

---

## 9. Known gaps to close before production traffic

| # | Gap | Fix |
|---|---|---|
| 1 | `DEV_PASSTHROUGH_UID` disables auth. | Ensure it is **unset** in the production Railway environment. |
| 2 | No per-user rate limiting. | Phase D — piggyback on existing `apiKeys.rateLimit` pattern or add a per-uid token counter. |
| 3 | `generate_tithis` admin tool is stubbed. | Needs an HTTPS variant of the `computeEphemeris` Cloud Function before it can run from a non-browser context. |
| 4 | No structured logs. | Add a request-id + uid + tool-name logger (pino or similar) before opening to real users. |

**Resolved during build-out** (do not skip, still required before the first prod deploy):

- **React `/settings/llm` page** — built at `src/components/Settings/LlmSettingsPage.js`, routed in `App.js`, reachable from both `SettingsMenu` (AI Provider item) and the in-chat `UnconfiguredPrompt` CTA.
- **Firestore rule lockdown for `userLlmConfigs/*`** — see §8.1 above for the exact rule block and deploy command.

---

## 10. Troubleshooting

**Build fails on `npm ci` for `@anthropic-ai/bedrock-sdk`.** It's an optional dep; the Dockerfile passes `--include=optional` on the runtime install. If you don't need Bedrock, leave `LLM_PROVIDER=anthropic` and the module is never required.

**`FirebaseError: 7 PERMISSION_DENIED`.** The service-account JSON is wrong, truncated, or points at a different project. Re-download from the correct project and paste the **full** JSON into `FIREBASE_SERVICE_ACCOUNT_JSON` (including the closing `}`).

**`Error: Missing Bearer token` on every `/api/chat` call from the browser.** The React app isn't attaching the ID token. Check that `auth.currentUser` is non-null when the request fires, and that `chatBackendService.getIdToken()` is being awaited.

**CORS blocked** — browser console shows `No 'Access-Control-Allow-Origin'`. `ALLOWED_ORIGINS` doesn't include the Firebase Hosting domain, **or** the CORS middleware isn't installed (see §3.1). Fix the env var or the code, redeploy.

**Chat hangs, then `Exceeded tool-hop limit`.** The model is looping. Usually a tool-description or schema issue. Check the Railway logs for the tool call sequence; `MAX_HOPS=6` in `mcp-client/src/chat.ts` can be raised temporarily.

**Container restart loop.** Most common cause: the MCP-server subprocess crashed on boot because Firebase env vars are missing or malformed. Check the first 20 lines of the deploy log for a firebase-admin error.

**Cold-start latency spikes.** Railway keeps the container warm under load, but idle instances can take 2–3 s to respond to the first request. If this matters, set `Sleep Application` to off in Railway settings (uses more billed hours).

---

## 11. Optional — second Railway service for external Claude clients (Phase 3)

When you're ready to expose the MCP server itself to hosted Claude.ai or other external clients (not the in-app chat), add a **second Railway service** pointing at the same repo with a different CMD:

- **Dockerfile override** (or a separate `Dockerfile.mcp-http`):
  ```
  WORKDIR /app/mcp-server
  CMD ["node", "dist/index-http.js"]
  ```
- **Required variables:** Firebase trio from §4.1, plus `PORT`. No LLM keys needed — this service speaks MCP, not LLM.
- **Auth:** still accepts Firebase ID tokens today; OAuth provider (Clerk) wires in at Phase 3 of the main planning doc.
- **Endpoint:** `POST /mcp` with `Authorization: Bearer <firebase-id-token>`.

Skip this section entirely until the in-app chat is stable.

---

## 12. Quick reference — minimum var set for first deploy

Paste this block into Railway (filling in the secrets):

```
FIREBASE_PROJECT_ID=hamropanchanga
FIREBASE_DATABASE_ID=hamropanchanga-db
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account", ...}

LLM_CONFIG_ENC_KEY=<32-bytes-base64>

MCP_SERVER_COMMAND=node
MCP_SERVER_ARGS=/app/mcp-server/dist/index.js

ALLOWED_ORIGINS=https://hamropanchanga.web.app

NODE_ENV=production
```

That's the minimum to get a green `/health` response and accept `PUT /api/llm-config` from real users. No global LLM key needed — each user supplies their own via the React settings page.

If you want a fallback to a shared key during early testing, add:

```
LLM_CONFIG_FALLBACK_ENV=true
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7
```
