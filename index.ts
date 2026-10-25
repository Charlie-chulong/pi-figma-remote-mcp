/**
 * pi-figma-remote-mcp — pi extension
 *
 * Connects pi to the Figma remote MCP server (https://mcp.figma.com/mcp).
 * Requires OAuth2 authentication. Provides full feature set including
 * use_figma, generate_figma_design, create_new_file, and search_design_system.
 *
 * Use this when you need remote-only features or don't have the Figma desktop app.
 * For desktop-based workflows, use pi-figma-mcp instead.
 *
 * Tools are discovered dynamically from the server on session start.
 * Commands:
 *   /figma-remote       — show connection status and available tools
 *   /figma-remote-auth  — run OAuth authentication
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ## Config

const MCP_URL = "https://mcp.figma.com/mcp";
const MAX_OUTPUT_BYTES = 50 * 1024;
const TOKEN_PATH = join(homedir(), ".pi", "figma-remote-mcp-token.json");

const OAUTH_AUTHORIZATION_URL = "https://www.figma.com/oauth/mcp";
const OAUTH_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const OAUTH_CALLBACK_PORT = 9876;
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;
const OAUTH_REGISTRATION_URL = "https://api.figma.com/v1/oauth/mcp/register";

// ## State

let sessionId: string | undefined;
let requestId = 1;
let connected = false;
let availableTools: Array<{ name: string; description: string }> = [];
let accessToken: string | undefined;
let refreshToken: string | undefined;
let clientId: string | undefined;
let clientSecret: string | undefined;
let tokenExpiresAt = 0;

// ## Token persistence

interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

function loadToken(): boolean {
  try {
    if (!existsSync(TOKEN_PATH)) return false;
    const data: TokenData = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    tokenExpiresAt = data.expiresAt ?? 0;
    clientId = data.clientId;
    clientSecret = data.clientSecret;
    return !!accessToken;
  } catch {
    return false;
  }
}

function saveToken(): void {
  try {
    mkdirSync(join(homedir(), ".pi"), { recursive: true });
    const data: TokenData = {
      accessToken: accessToken!,
      refreshToken,
      expiresAt: tokenExpiresAt,
      clientId,
      clientSecret,
    };
    writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Non-fatal
  }
}

// ## PKCE helpers

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ## OAuth 2.0 dynamic client registration + PKCE

async function registerOAuthClient(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const res = await fetch(OAUTH_REGISTRATION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude Code",
      redirect_uris: [OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:connect",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  return { clientId: data.client_id, clientSecret: data.client_secret ?? "" };
}

async function waitForAuthCode(
  state: string
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("OAuth timeout — no callback received within 120s"));
    }, 120_000);

    server = createServer((req, res) => {
      const url = new URL(
        req.url!,
        `http://localhost:${OAUTH_CALLBACK_PORT}`
      );
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authentication failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Invalid callback</h2><p>You can close this tab.</p></body></html>`
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h2>Authenticated with Figma ✓</h2><p>You can close this tab and return to pi.</p></body></html>`
      );
      clearTimeout(timeout);
      server.close();
      resolve({ code, state: returnedState });
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {});
    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Could not start OAuth callback server on port ${OAUTH_CALLBACK_PORT}: ${err.message}`
        )
      );
    });
  });
}

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string
): Promise<void> {
  const params: Record<string, string> = {
    client_id: clientId!,
    redirect_uri: OAUTH_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
  };
  if (clientSecret) params.client_secret = clientSecret;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiresAt = data.expires_in
    ? Date.now() + data.expires_in * 1000
    : 0;
  saveToken();
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken || !clientId) return false;

  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret ?? "",
      }).toString(),
    });

    if (!res.ok) return false;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    tokenExpiresAt = data.expires_in
      ? Date.now() + data.expires_in * 1000
      : 0;
    saveToken();
    return true;
  } catch {
    return false;
  }
}

async function runFullOAuthFlow(ctx: {
  ui: { notify: (msg: string, level: string) => void };
}): Promise<boolean> {
  ctx.ui.notify("Registering with Figma MCP server...", "info");
  const reg = await registerOAuthClient();
  clientId = reg.clientId;
  clientSecret = reg.clientSecret;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(OAUTH_AUTHORIZATION_URL);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "mcp:connect");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  ctx.ui.notify(
    `Opening browser for Figma authentication...\n\nIf the browser doesn't open, visit:\n${authUrl.toString()}`,
    "info"
  );

  const { exec } = await import("node:child_process");
  exec(`open "${authUrl.toString()}"`);

  const { code } = await waitForAuthCode(state);
  await exchangeCodeForToken(code, codeVerifier);

  return true;
}

[Showing lines 1-300 of 707. Use :301 to continue]