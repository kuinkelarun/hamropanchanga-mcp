# HamroPanchanga MCP — Local Configuration & Launch Guide

Two Node services live in this folder:

| Folder | What it is | When you need it |
|---|---|---|
| `mcp-server/` | The MCP server itself — wraps Firestore with AI tools (trees, members, events, tithi, calendar, admin). | Always. |
| `mcp-client/` | A chat backend that speaks to Claude and forwards tool calls to the MCP server. Uses either the Anthropic API or AWS Bedrock. | Only if you are building the in-app chatbot. Skip entirely if you are testing via Claude Desktop. |

You can test end-to-end without any LLM API key by using **Claude Desktop** (path 1 below). The chat backend is only needed for the in-app chat UI.

---

## Prerequisites

- Node.js 20+ (22 recommended)
- Access to the `hamropanchanga` Firebase project
- A Firebase **service-account JSON key**
  - Firebase Console → Project Settings → Service accounts → *Generate new private key*
  - Save the file somewhere outside the repo (never commit it)
- Your own **Firebase Auth uid** (look it up in Firebase Console → Authentication → Users)
- **One** of:
  - Claude Desktop installed (free path — recommended for initial testing), OR
  - An Anthropic API key, OR
  - AWS credentials with access to Bedrock + a Claude model enabled in your region

---

## Path 1 — Test with Claude Desktop (no LLM key needed)

This path runs the MCP server only. Claude Desktop becomes the client and uses your existing Claude subscription.

### 1. Install & build the MCP server

```bash
cd mcp-server
npm install
npm run build
```

### 2. Configure Claude Desktop

Open (create if missing) `%APPDATA%\Claude\claude_desktop_config.json` on Windows (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hamropanchanga": {
      "command": "node",
      "args": [
        "C:\\private\\test-claude-code\\family-tree-app\\hamropanchanga-mcp\\mcp-server\\dist\\index.js"
      ],
      "env": {
        "FIREBASE_PROJECT_ID": "hamropanchanga",
        "FIREBASE_DATABASE_ID": "hamropanchanga-db",
        "GOOGLE_APPLICATION_CREDENTIALS": "C:\\absolute\\path\\to\\service-account.json",
        "TEST_USER_ID": "your-firebase-uid-here"
      }
    }
  }
}
```

Use absolute paths. Double backslashes are required in JSON on Windows.

### 3. Restart Claude Desktop

Fully quit and relaunch. The "🔌" icon in the chat input should show a **hamropanchanga** server with all tools listed.

### 4. Try it

Ask Claude things like:
- *"What tithi is today?"*
- *"List my family trees."*
- *"Show events in the next 30 days."*
- *"Convert 2083 Baishakh 10 to AD."*
- *"Add my cousin Sita, born 1995-03-12, to the Smith Family."*

Any tool call Claude makes runs against live Firestore (scoped to `TEST_USER_ID`).

---

## Path 2 — Test with the chat backend (requires an LLM key)

Use this path if you want to exercise the `/api/chat` endpoint that the React app will eventually call. The chat backend spawns the MCP server as a subprocess and drives Claude through either provider.

### 1. Build the MCP server

```bash
cd mcp-server
npm install
npm run build
```

### 2. Install chat backend

```bash
cd ../mcp-client
npm install
cp .env.example .env
```

### 3. Pick your LLM provider

Edit `mcp-client/.env`.

#### Option A — Anthropic direct API

```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7
```

#### Option B — AWS Bedrock

```
LLM_PROVIDER=bedrock
AWS_REGION=us-east-1
BEDROCK_MODEL=anthropic.claude-opus-4-v1:0
# Credentials via the default AWS chain. To set explicitly:
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...   (only for temporary creds)
```

Notes for Bedrock:
- You must have **model access enabled** in the Bedrock console for the region you target. Opening a brand-new AWS account won't have Claude enabled by default — request access under Bedrock → *Model access*.
- Exact model IDs vary by region. Check Bedrock console → *Model catalog*. Common IDs follow `anthropic.claude-<variant>-v1:0`.
- The chat backend installs `@anthropic-ai/bedrock-sdk` as an **optional** dependency, so it's present after `npm install`.

### 4. Provide chat-backend auth config

The backend normally expects a Firebase ID token from the React app. For local testing, short-circuit it:

```
DEV_PASSTHROUGH_UID=your-firebase-uid-here
FIREBASE_PROJECT_ID=hamropanchanga
```

Also set the MCP-server subprocess env:

```
GOOGLE_APPLICATION_CREDENTIALS=C:\absolute\path\to\service-account.json
FIREBASE_DATABASE_ID=hamropanchanga-db
TEST_USER_ID=your-firebase-uid-here
```

(The last three are forwarded to the MCP-server child process.)

### 5. Run

```bash
npm run dev
```

You should see:

```
[chat-backend] MCP connected (34 tools); LLM provider=anthropic model=claude-opus-4-7
[chat-backend] listening on http://localhost:3001
```

### 6. Smoke-test

```bash
curl http://localhost:3001/health

curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"What tithi is today?"}]}'
```

The response includes the assistant reply and every tool call made along the way.

---

## Path 3 — Run the MCP server in HTTP mode

For when you're ready to host the MCP server remotely or let the chat backend reach it over HTTP instead of stdio.

```bash
cd mcp-server
npm run build
npm run start:http
```

Requests hit `POST /mcp` with either:
- `Authorization: Bearer <firebase-id-token>` + `X-Auth-Type: firebase`, or
- `DEV_PASSTHROUGH_UID=<uid>` in the environment for local testing

OAuth for external Claude.ai clients is a Phase 3 follow-up (not wired yet).

---

## LLM provider decision matrix

| | Anthropic direct | AWS Bedrock | Claude Desktop |
|---|---|---|---|
| API key needed | Anthropic console | AWS account + Bedrock model access | None (uses your Claude subscription) |
| Cost model | Per-token usage billed by Anthropic | Per-token usage billed by AWS | Claude subscription |
| Region control | N/A | Pick AWS region | N/A |
| Data residency | Anthropic infra | Stays in your AWS region | Anthropic infra |
| Good for | Fast local iteration, production | Enterprise with AWS lock-in, data-residency needs | Free dev testing, exploring tool behavior |
| Setup time | ~2 min | ~15 min (model access approval) | ~2 min |

The chat backend treats Anthropic and Bedrock as drop-in alternatives — switching is a one-line env change.

---

## Troubleshooting

**`Error: No auth context. In stdio mode set TEST_USER_ID`** — The MCP server started but couldn't resolve a user. Set `TEST_USER_ID` to your Firebase Auth uid in the server env.

**`FirebaseError: 7 PERMISSION_DENIED`** — Service-account key doesn't have Firestore access or wrong project. Re-download the key from the correct Firebase project.

**Tools work but `list_trees` returns empty** — Your `TEST_USER_ID` uid owns no trees. Sign into the React app with that uid and create one, or switch the env var to a uid that already has data.

**`ValidationException: The model ID ... isn't supported`** (Bedrock) — Either the model isn't enabled in your region's Bedrock, or the model ID string is wrong. Check Bedrock console → *Model access*.

**Chat backend exits with `Cannot find module '@anthropic-ai/bedrock-sdk'`** — Optional dep didn't install. Run `npm install --include=optional` in `mcp-client/`.

**Claude Desktop doesn't show the server** — Check the JSON is valid (no trailing commas), the path in `args` is correct and absolute, `dist/index.js` exists (did you run `npm run build`?), and fully quit Claude Desktop (not just close the window) before reopening.

**`EADDRINUSE` on port 3001** — Chat backend: change `PORT` in `.env`.

---

## File layout

```
hamropanchanga-mcp/
├── README.md                       (this file)
├── mcp-server/
│   ├── src/
│   │   ├── index.ts                stdio entry (Claude Desktop)
│   │   ├── index-http.ts           HTTP/SSE entry (hosted deploys)
│   │   ├── firebase.ts             admin SDK init
│   │   ├── auth.ts                 auth context + ALS
│   │   ├── constants.ts            collection names + date helpers
│   │   └── tools/                  one file per feature area
│   ├── package.json
│   └── tsconfig.json
└── mcp-client/
    ├── src/
    │   ├── index.ts                express entry
    │   ├── mcp-client.ts           spawns + talks to mcp-server
    │   ├── providers.ts            Anthropic vs Bedrock switch
    │   ├── chat.ts                 /api/chat tool-use loop
    │   └── auth.ts                 Firebase ID token middleware
    ├── package.json
    └── tsconfig.json
```
