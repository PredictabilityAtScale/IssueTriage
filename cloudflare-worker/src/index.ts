import { Router } from "itty-router";

type Env = {
  ISSUETRIAGE_OPENROUTER_API_KEY?: string;
  OPENROUTER_API_BASE?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_NAME?: string;
  ISSUETRIAGE_GITHUB_CLIENT_ID?: string;
  ISSUETRIAGE_GITHUB_CLIENT_SECRET?: string;
  GITHUB_AUTHORIZE_URL?: string;
  GITHUB_TOKEN_URL?: string;
  GITHUB_DEVICE_CODE_URL?: string;
};

const encoder = new TextEncoder();

const jsonResponse = (data: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
};

const base64Url = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

const signState = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(signature);
};

const packState = async (secret: string) => {
  const nonce = crypto.randomUUID();
  const signature = await signState(secret, nonce);
  return `${nonce}.${signature}`;
};

const verifyState = async (secret: string, state: string) => {
  const delimiter = state.lastIndexOf(".");
  if (delimiter < 1) {
    return false;
  }
  const nonce = state.slice(0, delimiter);
  const signature = state.slice(delimiter + 1);
  const expected = await signState(secret, nonce);
  return constantTimeEqual(signature, expected);
};

const openRouterHeaders = (env: Env) => {
  const headers: Record<string, string> = {};
  if (env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = env.OPENROUTER_SITE_URL;
  }
  if (env.OPENROUTER_APP_NAME) {
    headers["X-Title"] = env.OPENROUTER_APP_NAME;
  }
  return headers;
};

const router = Router();

router.get("/oauth/authorize", async (request: Request, env: Env) => {
  const clientId = env.ISSUETRIAGE_GITHUB_CLIENT_ID;
  const clientSecret = env.ISSUETRIAGE_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("GitHub OAuth not configured", { status: 500 });
  }

  const url = new URL(request.url);
  const redirectUri = url.searchParams.get("redirect_uri");
  if (!redirectUri) {
    return new Response("redirect_uri is required", { status: 400 });
  }

  const scope = url.searchParams.get("scope") ?? "repo user:email";
  const authorizeBase = env.GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize";

  const state = await packState(clientSecret);
  const authorizeUrl = new URL(authorizeBase);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("state", state);

  return jsonResponse({ authorizationUrl: authorizeUrl.toString(), state });
});

router.post("/oauth/exchange", async (request: Request, env: Env) => {
  const clientId = env.ISSUETRIAGE_GITHUB_CLIENT_ID;
  const clientSecret = env.ISSUETRIAGE_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("GitHub OAuth not configured", { status: 500 });
  }

  type ExchangePayload = {
    code?: string;
    state?: string;
    redirectUri?: string;
  };

  let body: ExchangePayload;
  try {
    body = (await request.json()) as ExchangePayload;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { code, state, redirectUri } = body;
  if (!code || !state) {
    return new Response("code and state are required", { status: 400 });
  }

  const validState = await verifyState(clientSecret, state);
  if (!validState) {
    return new Response("Invalid state", { status: 400 });
  }

  const tokenUrl = env.GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token";
  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    state,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token request failed";
    return new Response(message, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
});

router.post("/oauth/device/start", async (request: Request, env: Env) => {
  const clientId = env.ISSUETRIAGE_GITHUB_CLIENT_ID;
  if (!clientId) {
    return new Response("GitHub OAuth not configured", { status: 500 });
  }

  type StartPayload = {
    scopes?: string[] | string;
  };

  let payload: StartPayload | undefined;
  try {
    payload = (await request.json()) as StartPayload;
  } catch {
    payload = undefined;
  }

  const scopes = Array.isArray(payload?.scopes)
    ? payload?.scopes.filter((scope) => typeof scope === "string" && scope.trim().length > 0)
    : typeof payload?.scopes === "string"
      ? payload.scopes.split(/\s+/)
      : [];

  const scopeValue = scopes.length > 0 ? scopes.join(" ") : "repo read:user";
  const deviceUrl = env.GITHUB_DEVICE_CODE_URL ?? "https://github.com/login/device/code";

  let upstream: Response;
  try {
    upstream = await fetch(deviceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: scopeValue,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device authorization start failed";
    return new Response(message, { status: 502 });
  }

  let data: Record<string, unknown>;
  try {
    data = (await upstream.json()) as Record<string, unknown>;
  } catch {
    return new Response("Invalid response from GitHub", { status: 502 });
  }

  if (!upstream.ok || typeof data.error === "string") {
    const description = typeof data.error_description === "string"
      ? data.error_description
      : typeof data.error === "string"
        ? data.error
        : "Device authorization failed";
    return jsonResponse({
      status: data.error ?? "error",
      errorDescription: description,
    }, { status: upstream.status >= 400 ? upstream.status : 400 });
  }

  const deviceCode = typeof data.device_code === "string" ? data.device_code : undefined;
  const userCode = typeof data.user_code === "string" ? data.user_code : undefined;
  const verificationUri = typeof data.verification_uri === "string" ? data.verification_uri : undefined;
  const verificationUriComplete = typeof data.verification_uri_complete === "string"
    ? data.verification_uri_complete
    : undefined;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  const interval = typeof data.interval === "number" ? data.interval : Number(data.interval);

  if (!deviceCode || !userCode || !verificationUri || Number.isNaN(expiresIn) || Number.isNaN(interval)) {
    return new Response("GitHub response missing device flow details", { status: 502 });
  }

  return jsonResponse({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
  });
});

router.post("/oauth/device/poll", async (request: Request, env: Env) => {
  const clientId = env.ISSUETRIAGE_GITHUB_CLIENT_ID;
  const clientSecret = env.ISSUETRIAGE_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("GitHub OAuth not configured", { status: 500 });
  }

  type PollPayload = {
    deviceCode?: string;
  };

  let payload: PollPayload;
  try {
    payload = (await request.json()) as PollPayload;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const deviceCode = typeof payload.deviceCode === "string" ? payload.deviceCode : undefined;
  if (!deviceCode) {
    return new Response("deviceCode is required", { status: 400 });
  }

  const tokenUrl = env.GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token";

  let upstream: Response;
  try {
    upstream = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device authorization polling failed";
    return new Response(message, { status: 502 });
  }

  let data: Record<string, unknown>;
  try {
    data = (await upstream.json()) as Record<string, unknown>;
  } catch {
    return new Response("Invalid response from GitHub", { status: 502 });
  }

  if (!upstream.ok) {
    const description = typeof data.error_description === "string"
      ? data.error_description
      : typeof data.error === "string"
        ? data.error
        : "Device authorization failed";
    return jsonResponse({
      status: data.error ?? "error",
      errorDescription: description,
    }, { status: upstream.status });
  }

  if (typeof data.error === "string") {
    const description = typeof data.error_description === "string"
      ? data.error_description
      : data.error;
    const retryAfter = typeof data.retry_after === "number" ? data.retry_after : undefined;
    if (data.error === "authorization_pending" || data.error === "slow_down") {
      return jsonResponse({
        status: data.error,
        errorDescription: description,
        retryAfter,
      }, { status: 202 });
    }
    return jsonResponse({
      status: data.error,
      errorDescription: description,
    }, { status: 400 });
  }

  const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
  if (!accessToken) {
    return new Response("GitHub response missing access token", { status: 502 });
  }

  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : Number(data.expires_in);
  const scope = typeof data.scope === "string" ? data.scope : undefined;
  const tokenType = typeof data.token_type === "string" ? data.token_type : undefined;

  return jsonResponse({
    accessToken,
    refreshToken,
    expiresIn: Number.isNaN(expiresIn) ? undefined : expiresIn,
    scope,
    tokenType,
  });
});

router.post("/llm", async (request: Request, env: Env) => {
  const apiKey = env.ISSUETRIAGE_OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response("Missing ISSUETRIAGE_OPENROUTER_API_KEY binding", { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const apiBase = env.OPENROUTER_API_BASE ?? "https://openrouter.ai/api/v1";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };

  Object.assign(headers, openRouterHeaders(env));

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream request failed";
    return new Response(message, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
});

router.all("*", () => new Response("Not found", { status: 404 }));

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.handle(request, env, ctx);
  },
};
