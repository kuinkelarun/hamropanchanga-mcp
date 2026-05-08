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
    service_name: "HamroPanchanga",
    logo_uri: `${base}/public/HamroPanchangaLogo.png`,
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

  // Redirect to our hosted login-choice page (Google or email/password)
  try {
    res.redirect(`${baseUrl()}/login?nonce=${nonce}`);
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

// ─── login page (hosted) ────────────────────────────────────────────────────

/**
 * Serve the hosted login-choice page.
 * Validates the nonce is still pending before serving HTML.
 */
export async function handleLoginPage(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { nonce, error: errorParam } = req.query as Record<string, string>;

  if (!nonce) {
    res.status(400).send("Missing nonce");
    return;
  }

  const pendingSnap = await db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce).get();
  if (!pendingSnap.exists || pendingSnap.data()!.type !== "pending") {
    res.status(400).send("Invalid or expired login session. Please return to Claude and try again.");
    return;
  }
  if (pendingSnap.data()!.expiresAt.toMillis() < Date.now()) {
    await db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce).delete();
    res.status(400).send("Login session expired. Please return to Claude and try again.");
    return;
  }

  const errorMessages: Record<string, string> = {
    invalid_credentials: "Incorrect email or password.",
    no_account: "No Hamropanchanga account found for this email. Please contact an admin.",
    expired: "Login session expired. Please return to Claude and try again.",
    email_not_verified: "Please verify your email address before connecting. Check your inbox for a verification link.",
    server_error: "Something went wrong. Please try again.",
  };
  const errorMessage = errorParam ? (errorMessages[errorParam] ?? "Something went wrong.") : "";

  const base = baseUrl();
  // Inline the login HTML with the nonce embedded in form fields / links
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in to HamroPanchanga</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .card{background:#fff;border-radius:1rem;box-shadow:0 4px 24px rgba(0,0,0,.10);padding:2rem;width:100%;max-width:360px;text-align:center}
    .logo{width:64px;height:64px;margin:0 auto 1rem}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:.25rem;color:#111}
    .subtitle{color:#6b7280;font-size:.875rem;margin-bottom:1.5rem}
    .btn{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding:.75rem 1rem;border-radius:.75rem;font-size:.9rem;font-weight:600;cursor:pointer;transition:background .15s,box-shadow .15s;text-decoration:none}
    .btn-google{background:#fff;border:1px solid #d1d5db;color:#374151;box-shadow:0 1px 3px rgba(0,0,0,.07)}
    .btn-google:hover{background:#f9fafb}
    .btn-primary{background:#2563eb;border:none;color:#fff;margin-top:.5rem}
    .btn-primary:hover{background:#1d4ed8}
    .divider{display:flex;align-items:center;gap:.75rem;margin:1rem 0;color:#9ca3af;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
    .divider hr{flex:1;border:none;border-top:1px solid #e5e7eb}
    input{width:100%;padding:.75rem 1rem;border:1px solid #d1d5db;border-radius:.75rem;font-size:.875rem;margin-bottom:.6rem;outline:none;transition:border .15s}
    input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}
    .error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:.5rem;padding:.6rem .9rem;font-size:.825rem;margin-bottom:1rem;text-align:left}
    .forgot{font-size:.8rem;color:#6b7280;margin-top:.75rem}
    .forgot a{color:#2563eb;text-decoration:none}
    .forgot a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="${base}/public/HamroPanchangaLogo.png" alt="HamroPanchanga" />
    <h1>Sign in</h1>
    <p class="subtitle">Connect to HamroPanchanga</p>

    ${errorMessage ? `<div class="error">${errorMessage}</div>` : ""}

    <a class="btn btn-google" href="${base}/oauth/google-redirect?nonce=${nonce}">
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <g fill="none" fill-rule="evenodd">
          <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </g>
      </svg>
      Continue with Google
    </a>

    <div class="divider"><hr />or<hr /></div>

    <form method="POST" action="${base}/oauth/email-login">
      <input type="hidden" name="nonce" value="${nonce}" />
      <input type="email" name="email" placeholder="Email address" required autocomplete="email" />
      <input type="password" name="password" placeholder="Password" required autocomplete="current-password" />
      <button type="submit" class="btn btn-primary">Sign in with email</button>
    </form>

    <p class="forgot">Forgot your password? <a href="${process.env.MAIN_APP_URL ?? "https://hamropanchanga.com"}">Reset it on the app</a></p>
  </div>
</body>
</html>`);
}

// ─── google redirect (from login page) ──────────────────────────────────────

/**
 * Thin redirect: validates the nonce and forwards to Google OAuth.
 * This preserves the existing Google flow while going through the new login page.
 */
export async function handleGoogleRedirect(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { nonce } = req.query as Record<string, string>;

  if (!nonce) {
    res.status(400).send("Missing nonce");
    return;
  }

  const pendingSnap = await db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce).get();
  if (!pendingSnap.exists || pendingSnap.data()!.type !== "pending") {
    res.status(400).send("Invalid or expired login session.");
    return;
  }
  if (pendingSnap.data()!.expiresAt.toMillis() < Date.now()) {
    res.status(400).send("Login session expired. Please return to Claude and try again.");
    return;
  }

  const firebaseCallbackUrl = `${baseUrl()}/oauth/callback`;
  res.redirect(buildGoogleOAuthUrl(firebaseCallbackUrl, nonce));
}

// ─── email/password login (from login page form) ─────────────────────────────

/**
 * Accept email + password submitted from the hosted login page.
 * Authenticates via Firebase Identity Toolkit REST API (signInWithPassword),
 * then issues an OAuth auth code exactly as handleOAuthCallback() does for Google.
 */
export async function handleEmailLogin(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const { email, password, nonce } = req.body ?? {};

  if (!email || !password || !nonce) {
    res.status(400).send("Missing required fields");
    return;
  }

  // Load and validate the pending auth session
  const pendingRef = db().collection(COLLECTIONS.OAUTH_CODES).doc(nonce as string);
  const pendingSnap = await pendingRef.get();

  if (!pendingSnap.exists || pendingSnap.data()!.type !== "pending") {
    res.redirect(`${baseUrl()}/login?nonce=${nonce}&error=expired`);
    return;
  }
  if (pendingSnap.data()!.expiresAt.toMillis() < Date.now()) {
    await pendingRef.delete();
    res.redirect(`${baseUrl()}/login?nonce=${nonce}&error=expired`);
    return;
  }

  const pending = pendingSnap.data()!;

  // Authenticate with Firebase Identity Toolkit REST (signInWithPassword)
  let uid: string;
  try {
    const result = await signInWithEmailPassword(email as string, password as string);
    uid = result.uid;
    if (!result.emailVerified) {
      res.redirect(`${baseUrl()}/login?nonce=${nonce}&error=email_not_verified`);
      return;
    }
  } catch (err) {
    console.error("[oauth] email login failed:", (err as Error).message);
    res.redirect(`${baseUrl()}/login?nonce=${nonce}&error=invalid_credentials`);
    return;
  }

  // Verify this UID has a Hamropanchanga account
  const userDoc = await db().collection(COLLECTIONS.USERS).doc(uid).get();
  if (!userDoc.exists) {
    res.redirect(`${baseUrl()}/login?nonce=${nonce}&error=no_account`);
    return;
  }

  // Issue an auth code — same logic as handleOAuthCallback()
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

  const redirectParams = new URLSearchParams({ code: authCode });
  if (pending.originalState) redirectParams.set("state", pending.originalState);
  res.redirect(`${pending.redirectUri}?${redirectParams}`);
}

/**
 * Sign in with email + password via Firebase Identity Toolkit REST API.
 * Returns the Firebase UID (localId) on success, throws on failure.
 */
async function signInWithEmailPassword(email: string, password: string): Promise<{ uid: string; emailVerified: boolean }> {
  const apiKey = firebaseWebApiKey();
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Firebase signInWithPassword failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as { localId?: string; emailVerified?: boolean; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  if (!data.localId) throw new Error("No localId in Firebase response");
  return { uid: data.localId, emailVerified: data.emailVerified ?? false };
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
