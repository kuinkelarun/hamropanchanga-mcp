/**
 * OAuth 2.1 Authorization Server for the MCP HTTP transport.
 *
 * Implements the MCP Authorization spec (2025-03-26):
 *   GET  /.well-known/oauth-authorization-server  — metadata discovery
 *   POST /register                                — dynamic client registration (RFC 7591)
 *   GET  /authorize                               — start auth-code + PKCE flow
 *   GET  /oauth/callback                          — Firebase/Google callback
 *   POST /token                                   — code → access+refresh tokens
 *
 * Identity provider: Firebase Authentication (Google OAuth).
 * Access tokens are short-lived JWTs signed with MCP_JWT_SECRET.
 * Refresh tokens are opaque random strings stored in Firestore (oauthTokens).
 */

import express from "express";
import { randomBytes, createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import jwt from "jsonwebtoken";
import { db } from "./firebase.js";
import { COLLECTIONS } from "./constants.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function baseUrl(): string {
  const u = process.env.MCP_SERVER_BASE_URL;
  if (!u) throw new Error("MCP_SERVER_BASE_URL is not set");
  return u.replace(/\/$/, "");
}

function jwtSecret(): string {
  const s = process.env.MCP_JWT_SECRET;
  if (!s) throw new Error("MCP_JWT_SECRET is not set");
  return s;
}

function firebaseWebApiKey(): string {
  const k = process.env.FIREBASE_WEB_API_KEY;
  if (!k) throw new Error("FIREBASE_WEB_API_KEY is not set");
  return k;
}

function googleClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set");
  return id;
}

function googleClientSecret(): string {
  const s = process.env.GOOGLE_CLIENT_SECRET;
  if (!s) throw new Error("GOOGLE_CLIENT_SECRET is not set");
  return s;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── metadata ───────────────────────────────────────────────────────────────

export function handleOAuthMetadata(_req: express.Request, res: express.Response): void {
  const base = baseUrl();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
  });
}

// ─── dynamic client registration ────────────────────────────────────────────

export async function handleClientRegistration(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { redirect_uris, client_name, grant_types, scope } = req.body ?? {};

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    return;
  }

  const clientId = randomBytes(16).toString("hex");
  const now = Timestamp.now();

  await db().collection(COLLECTIONS.OAUTH_CLIENTS).doc(clientId).set({
    clientId,
    redirectUris: redirect_uris,
    clientName: client_name ?? null,
    grantTypes: grant_types ?? ["authorization_code", "refresh_token"],
    scope: scope ?? "read write",
    createdAt: now,
  });

  res.status(201).json({
    client_id: clientId,
    redirect_uris,
    grant_types: grant_types ?? ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
}

// ─── authorize ──────────────────────────────────────────────────────────────

export async function handleAuthorize(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state,
    scope,
  } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }
  if (!client_id || !redirect_uri || !code_challenge || code_challenge_method !== "S256") {
    res.status(400).json({ error: "invalid_request", error_description: "client_id, redirect_uri, code_challenge (S256) required" });
    return;
  }

  // Verify the client exists and the redirect_uri is registered
  const clientSnap = await db().collection(COLLECTIONS.OAUTH_CLIENTS).doc(client_id).get();
  if (!clientSnap.exists) {
    res.status(400).json({ error: "invalid_client" });
    return;
  }
  const clientData = clientSnap.data()!;
  if (!clientData.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered" });
    return;
  }

  // Store pending auth params under a random nonce; we carry this through Firebase's `state`
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Timestamp.fromMillis(Date.now() + 10 * 60 * 1000); // 10 min

  await db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce).set({
    type: "pending",
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: "S256",
    originalState: state ?? null,
    scope: scope ?? "read write",
    expiresAt,
  });

  // Redirect to Google OAuth
  try {
    const firebaseCallbackUrl = `${baseUrl()}/oauth/callback`;
    const googleAuthUrl = buildGoogleOAuthUrl(firebaseCallbackUrl, nonce);
    res.redirect(googleAuthUrl);
  } catch (err) {
    res.status(500).json({ error: "server_error", error_description: (err as Error).message });
  }
}

function buildGoogleOAuthUrl(callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ─── oauth callback (Firebase → MCP) ────────────────────────────────────────

export async function handleOAuthCallback(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { code: googleCode, state: nonce, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).send(`OAuth error: ${error}`);
    return;
  }
  if (!googleCode || !nonce) {
    res.status(400).send("Missing code or state");
    return;
  }

  // Load pending auth params
  const pendingRef = db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce);
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists || pendingSnap.data()!.type !== "pending") {
    res.status(400).send("Invalid or expired state");
    return;
  }
  const pending = pendingSnap.data()!;
  if (pending.expiresAt.toMillis() < Date.now()) {
    await pendingRef.delete();
    res.status(400).send("Authorization request expired");
    return;
  }

  // Exchange Google auth code for Firebase ID token via REST API
  let uid: string;
  try {
    uid = await exchangeGoogleCodeForUid(googleCode, `${baseUrl()}/oauth/callback`);
  } catch (err) {
    console.error("[oauth] exchangeGoogleCodeForUid failed:", (err as Error).message);
    res.status(401).send(`Failed to exchange auth code: ${(err as Error).message}`);
    return;
  }

  // Issue an auth code and store it (replaces the pending doc)
  const authCode = randomBytes(32).toString("hex");
  const codeExpiresAt = Timestamp.fromMillis(Date.now() + 5 * 60 * 1000); // 5 min

  await pendingRef.set({
    type: "code",
    code: authCode,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
    scope: pending.scope,
    uid,
    expiresAt: codeExpiresAt,
    used: false,
  });

  // Redirect back to the MCP client with the code
  const redirectParams = new URLSearchParams({ code: authCode });
  if (pending.originalState) redirectParams.set("state", pending.originalState);
  res.redirect(`${pending.redirectUri}?${redirectParams}`);
}

async function exchangeGoogleCodeForUid(code: string, redirectUri: string): Promise<string> {
  // Step 1: Exchange the Google auth code for tokens at Google's token endpoint
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(`Google token exchange failed: ${tokenResp.status} ${body}`);
  }

  const tokenData = (await tokenResp.json()) as { id_token?: string; error?: string };
  if (tokenData.error || !tokenData.id_token) {
    throw new Error(`Google token exchange error: ${tokenData.error ?? "no id_token"}`);
  }

  // Step 2: Pass the Google ID token to Firebase to get the Firebase uid
  const apiKey = firebaseWebApiKey();
  const fbResp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(tokenData.id_token)}&providerId=google.com`,
        requestUri: "http://localhost",
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    },
  );

  if (!fbResp.ok) {
    const body = await fbResp.text();
    throw new Error(`Firebase signInWithIdp failed: ${fbResp.status} ${body}`);
  }

  const fbData = (await fbResp.json()) as { localId?: string; error?: { message: string } };
  if (fbData.error) throw new Error(fbData.error.message);
  if (!fbData.localId) throw new Error("No localId in Firebase response");
  return fbData.localId;
}

// ─── token endpoint ──────────────────────────────────────────────────────────

export async function handleTokenExchange(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { grant_type } = req.body ?? {};

  if (grant_type === "authorization_code") {
    await handleAuthorizationCodeGrant(req, res);
  } else if (grant_type === "refresh_token") {
    await handleRefreshTokenGrant(req, res);
  } else {
    res.status(400).json({ error: "unsupported_grant_type" });
  }
}

async function handleAuthorizationCodeGrant(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { code, client_id, redirect_uri, code_verifier } = req.body ?? {};

  if (!code || !client_id || !redirect_uri || !code_verifier) {
    res.status(400).json({ error: "invalid_request", error_description: "code, client_id, redirect_uri, code_verifier required" });
    return;
  }

  // Find the stored auth code
  const snap = await db()
    .collection(COLLECTIONS.OAUTH_CODES)
    .where("code", "==", code)
    .where("type", "==", "code")
    .limit(1)
    .get();

  if (snap.empty) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code not found" });
    return;
  }

  const docRef = snap.docs[0].ref;
  const codeData = snap.docs[0].data();

  if (codeData.used) {
    res.status(400).json({ error: "invalid_grant", error_description: "Code already used" });
    return;
  }
  if (codeData.expiresAt.toMillis() < Date.now()) {
    await docRef.delete();
    res.status(400).json({ error: "invalid_grant", error_description: "Code expired" });
    return;
  }
  if (codeData.clientId !== client_id || codeData.redirectUri !== redirect_uri) {
    res.status(400).json({ error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" });
    return;
  }

  // PKCE: verify S256(code_verifier) == codeChallenge
  if (s256(code_verifier) !== codeData.codeChallenge) {
    res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
    return;
  }

  // Mark code as used (single-use)
  await docRef.update({ used: true });

  const { uid, scope } = codeData;
  const { accessToken, refreshToken } = await issueTokens(uid, client_id, scope);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: refreshToken,
    scope,
  });
}

async function handleRefreshTokenGrant(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { refresh_token, client_id } = req.body ?? {};

  if (!refresh_token || !client_id) {
    res.status(400).json({ error: "invalid_request", error_description: "refresh_token and client_id required" });
    return;
  }

  const tokenHash = createHash("sha256").update(refresh_token).digest("hex");
  const snap = await db()
    .collection(COLLECTIONS.OAUTH_TOKENS)
    .where("refreshTokenHash", "==", tokenHash)
    .where("clientId", "==", client_id)
    .limit(1)
    .get();

  if (snap.empty) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token not found" });
    return;
  }

  const tokenData = snap.docs[0].data();
  if (tokenData.revokedAt) {
    res.status(400).json({ error: "invalid_grant", error_description: "Refresh token revoked" });
    return;
  }

  const accessToken = mintAccessToken(tokenData.uid, tokenData.scope);

  res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: tokenData.scope,
  });
}

// ─── token helpers ───────────────────────────────────────────────────────────

function mintAccessToken(uid: string, scope: string): string {
  return jwt.sign(
    { sub: uid, scope },
    jwtSecret(),
    { issuer: baseUrl(), expiresIn: "1h" },
  );
}

async function issueTokens(
  uid: string,
  clientId: string,
  scope: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = mintAccessToken(uid, scope);

  const rawRefreshToken = randomBytes(32).toString("hex");
  const refreshTokenHash = createHash("sha256").update(rawRefreshToken).digest("hex");

  await db().collection(COLLECTIONS.OAUTH_TOKENS).add({
    refreshTokenHash,
    clientId,
    uid,
    scope,
    issuedAt: Timestamp.now(),
    revokedAt: null,
  });

  return { accessToken, refreshToken: rawRefreshToken };
}
