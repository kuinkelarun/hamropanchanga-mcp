# MCP OAuth Setup Guide

This document explains the OAuth 2.1 support added to the **MCP server** (`mcp-server/`), how it differs from the existing API key flow, and the exact steps to enable it in production.

---

## What changed and why

### Before — manual API key flow

External MCP clients (Claude.ai, Cursor, Zed, MCP Inspector) had one way to connect: obtain an `npcal_*` API key by going through a manual request-and-approval workflow inside the app.

```
External MCP client (e.g. Claude.ai)
        │
        │  Authorization: Bearer npcal_abc123...
        ▼
┌───────────────────────────────────┐
│  MCP server (HTTP transport)      │
│                                   │
│  resolveUidFromRequest()          │
│    └─ npcal_* prefix?             │
│         └─ hash key               │
│         └─ query Firestore        │     ┌─────────────┐
│         └─ check active + quota   │────▶│  Firestore  │
│         └─ return uid             │     │  apiKeys    │
│                                   │     └─────────────┘
│  loadAuthContext(uid) → tools run │
└───────────────────────────────────┘

How you got the key:
  1. Sign in to the app
  2. Go to Settings → API Keys → Request access
  3. Admin reviews and approves the request
  4. Copy the raw key (shown once)
  5. Paste it into your MCP client config manually
```

This works well but has friction: every new client or user needs a human admin to approve a request, and the key must be copied and stored by the user.

---

### After — OAuth 2.1 flow (what was added)

The MCP server now acts as an OAuth 2.1 Authorization Server. MCP-aware clients that implement the [MCP Authorization spec](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/authorization/) — such as Claude.ai — can connect without any manual key management. The client discovers the auth endpoints automatically, registers itself, and opens a browser login window for the user.

```
External MCP client (e.g. Claude.ai)
        │
        │  Step 1: GET /.well-known/oauth-authorization-server
        ▼
┌───────────────────────────────────────────────────────┐
│  MCP server — new OAuth endpoints                     │
│                                                       │
│  /.well-known/oauth-authorization-server              │
│    └─ returns metadata (all endpoint URLs)            │
│                                                       │
│  POST /register                                       │
│    └─ client registers itself → gets client_id        │
│                                                       │
│  GET /authorize?client_id=...&code_challenge=...      │
│    └─ redirects user to Google login (via Firebase)   │
│                                                       │
│  GET /oauth/callback  ◀── Firebase/Google redirects   │
│    └─ receives Google auth code                       │
│    └─ exchanges with Firebase Identity Toolkit API    │
│    └─ gets Firebase uid                               │
│    └─ issues short-lived auth code (5 min)            │
│    └─ redirects back to MCP client                    │
│                                                       │
│  POST /token                                          │
│    └─ client sends code + PKCE verifier               │
│    └─ server verifies PKCE (S256)                     │
│    └─ issues JWT access token (1 hr) +                │
│       opaque refresh token (stored in Firestore)      │
└───────────────────────────────────────────────────────┘
        │
        │  Step 2 (all future MCP requests):
        │  Authorization: Bearer <JWT access token>
        ▼
┌───────────────────────────────────────────────────────┐
│  MCP server — resolveUidFromRequest() (updated)       │
│                                                       │
│  Priority order:                                      │
│   1. DEV_PASSTHROUGH_UID env  → dev bypass only       │
│   2. npcal_* prefix           → API key (unchanged)   │
│   3. Valid MCP JWT            → OAuth access token    │
│   4. Other JWT                → Firebase ID token     │
│                                                       │
│  loadAuthContext(uid) → tools run as before           │
└───────────────────────────────────────────────────────┘
```

**Key points:**

- Existing `npcal_*` API keys continue to work exactly as before — no migration needed.
- In-app chat (`mcp-client`) is not affected — it uses Firebase ID tokens over stdio, which is also unchanged.
- The user logs in with the same Google account they use in the HamroPanchanga app. The OAuth flow resolves to the same `uid`, so the connected MCP client has exactly the same permissions as the app user.
- Access tokens are short-lived JWTs (1 hour) signed by the MCP server. Refresh tokens are stored in a new `oauthTokens` Firestore collection and can be revoked.

---

## New Firestore collections

Three new collections are created automatically on first use (no migration needed — Firestore is schemaless):

| Collection | What's stored |
|---|---|
| `oauthClients` | Registered MCP clients (client_id, redirect URIs, name) |
| `oauthCodes` | Short-lived auth codes during the login flow (auto-expire in 5–10 min) |
| `oauthTokens` | Refresh tokens (hashed) linked to a uid — used to issue new access tokens |

---

## New environment variables

All three variables go into the **MCP server** (`mcp-server/`). On Railway, set them in the `hamropanchanga-mcp-server` service's **Variables** tab (not the chat backend service).

### `MCP_SERVER_BASE_URL`

The public HTTPS URL of the deployed MCP server, without a trailing slash.

```
MCP_SERVER_BASE_URL=https://hamropanchanga-mcp-server.up.railway.app
```

This is used in two places:
- The OAuth metadata response (`issuer` and all endpoint URLs) so clients know where to send requests.
- The `iss` (issuer) claim in every JWT access token, so the server can verify tokens it issued.

If this is wrong or missing, OAuth discovery fails and the Google callback redirect will not work.

### `MCP_JWT_SECRET`

A 256-bit random secret used to sign and verify JWT access tokens. Generate it once and treat it like a password — anyone who holds it can forge tokens.

Generate the value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Example output (generate your own — do not copy this):
```
a3f8c2d1e4b7a09f3c5e2d8b1a6f4e9c7d3b2a8f5e1c4d7b0a9e3f6c2d8b4a1
```

```
MCP_JWT_SECRET=<your generated hex string>
```

Rotating this value invalidates all currently-issued access tokens. Connected clients will need to re-authenticate (they will be prompted automatically on the next request, since they hold a refresh token).

### `FIREBASE_WEB_API_KEY`

The Firebase **Web API key** (not the service account JSON). This is a public-facing identifier that the MCP server uses to call Firebase's Identity Toolkit REST API to exchange a Google auth code for a Firebase `uid` during the OAuth callback.

Find it at:
> Firebase Console → Project Settings (gear icon) → General → Your apps → Web app → `apiKey`

It looks like:
```
FIREBASE_WEB_API_KEY=AIzaSyD-xxxxxxxxxxxxxxxxxxxxxxxxxxx
```

This key is safe to include in client-side code (Firebase designed it that way), but keep it out of public repos. On Railway it lives as an env var, which is the correct place.

---

## Setup steps

### Step 1 — Generate the JWT secret

Run this once on any machine with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output. You will not see this exact value again (if you lose it, just generate a new one and redeploy — connected OAuth clients will re-authenticate automatically).

### Step 2 — Get the Firebase Web API key

1. Open [Firebase Console](https://console.firebase.google.com/) and select the `hamropanchanga` project.
2. Click the gear icon → **Project settings**.
3. Under **Your apps**, find the Web app entry.
4. Copy the value of `apiKey` from the Firebase config snippet. It starts with `AIzaSy`.

### Step 3 — Configure the authorized redirect URI in Google Cloud

The MCP server's OAuth callback URL must be whitelisted in Google Cloud, otherwise Google will reject the redirect.

1. Open [Google Cloud Console](https://console.cloud.google.com/) → select the `hamropanchanga` project.
2. Navigate to **APIs & Services** → **Credentials**.
3. Click the **OAuth 2.0 Client ID** that Firebase uses (named something like `Web client (auto created by Google Service)`).
4. Under **Authorized redirect URIs**, add:
   ```
   https://hamropanchanga-mcp-server.up.railway.app/oauth/callback
   ```
5. Click **Save**.

Without this step the Google login will show an `redirect_uri_mismatch` error.

### Step 4 — Set the variables on Railway

In the Railway dashboard, open the **`hamropanchanga-mcp-server`** service (the standalone MCP server from `Dockerfile.mcp-http`) → **Variables** tab.

Add these three variables:

| Variable | Value |
|---|---|
| `MCP_SERVER_BASE_URL` | `https://hamropanchanga-mcp-server.up.railway.app` |
| `MCP_JWT_SECRET` | the hex string from Step 1 |
| `FIREBASE_WEB_API_KEY` | the `AIzaSy...` key from Step 2 |

Railway will redeploy automatically when you save.

### Step 5 — Verify the metadata endpoint

After the deploy finishes, run:

```bash
curl https://hamropanchanga-mcp-server.up.railway.app/.well-known/oauth-authorization-server
```

Expected response:

```json
{
  "issuer": "https://hamropanchanga-mcp-server.up.railway.app",
  "authorization_endpoint": "https://hamropanchanga-mcp-server.up.railway.app/authorize",
  "token_endpoint": "https://hamropanchanga-mcp-server.up.railway.app/token",
  "registration_endpoint": "https://hamropanchanga-mcp-server.up.railway.app/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["read", "write"]
}
```

If you get a 500 or a JSON error about a missing env var, check the Railway deploy logs — the most common cause is `MCP_SERVER_BASE_URL` not being set.

### Step 6 — Connect Claude.ai

1. Go to [claude.ai](https://claude.ai) → Settings → **Integrations** (or Connections, depending on your plan).
2. Click **Add integration** and paste the MCP server URL:
   ```
   https://hamropanchanga-mcp-server.up.railway.app
   ```
3. Claude.ai will automatically discover the OAuth endpoints and redirect you to the Google login.
4. Sign in with the same Google account you use in the HamroPanchanga app.
5. After login you are redirected back to Claude.ai. The MCP server's tools (trees, members, events, calendar, tithi) will appear in the tool list.

---

## Verify existing API keys still work

OAuth is additive — nothing was removed. You can confirm the old auth path is intact:

```bash
curl https://hamropanchanga-mcp-server.up.railway.app/mcp \
  -X POST \
  -H "Authorization: Bearer npcal_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

A `200` with a tools array means API key auth is working as before.

---

## Summary — which variables go where

| Variable | Service | Required for |
|---|---|---|
| `FIREBASE_PROJECT_ID` | mcp-server | Always required |
| `FIREBASE_DATABASE_ID` | mcp-server | Always required |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | mcp-server | Always required |
| `MCP_SERVER_BASE_URL` | **mcp-server** | OAuth only |
| `MCP_JWT_SECRET` | **mcp-server** | OAuth only |
| `FIREBASE_WEB_API_KEY` | **mcp-server** | OAuth only |

The chat backend service (`mcp-client`) does not need any of these new variables.
