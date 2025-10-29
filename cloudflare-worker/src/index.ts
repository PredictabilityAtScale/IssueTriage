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
