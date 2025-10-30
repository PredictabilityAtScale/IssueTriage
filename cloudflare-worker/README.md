# IssueTriage Cloudflare Worker

Use this Worker to proxy LLM requests and GitHub OAuth flows so secrets stay on the server.

## Setup

1. Install dependencies: `npm install`
2. Store secrets:
   ```bash
   npx wrangler secret put ISSUETRIAGE_OPENROUTER_API_KEY
   npx wrangler secret put ISSUETRIAGE_GITHUB_CLIENT_SECRET
   ```
3. Configure environment variable:
   - Set `ISSUETRIAGE_GITHUB_CLIENT_ID` in wrangler.toml or as a Cloudflare environment variable
4. Start locally: `npm run dev`
5. Deploy to Cloudflare: `npm run deploy`

## Endpoints

### LLM Proxy

**`POST /llm`**

Forwards chat completion requests to OpenRouter using the server-side `ISSUETRIAGE_OPENROUTER_API_KEY`. Optional vars `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` populate recommended OpenRouter headers.

**Request:**
```json
{
  "model": "openai/gpt-4",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**Response:** Proxied response from OpenRouter

---

### OAuth Helpers (Web Flow)

**`GET /oauth/authorize`**

Initiates GitHub OAuth web authorization flow with signed state token.

**Query Parameters:**
- `redirect_uri` (required): Callback URL after authorization
- `scope` (optional): Space-separated OAuth scopes (default: "repo user:email")

**Response:**
```json
{
  "authorizationUrl": "https://github.com/login/oauth/authorize?...",
  "state": "nonce.signature"
}
```

**`POST /oauth/exchange`**

Exchanges authorization code for access token.

**Request:**
```json
{
  "code": "authorization_code_from_github",
  "state": "signed_state_from_authorize",
  "redirectUri": "optional_redirect_uri"
}
```

**Response:** GitHub token response (proxied)

---

### OAuth Device Flow

**`POST /oauth/device/start`**

Initiates GitHub device authorization flow for headless/CLI environments.

**Request:**
```json
{
  "scopes": ["repo", "read:user"]
}
```

**Response:**
```json
{
  "deviceCode": "device_code_for_polling",
  "userCode": "XXXX-XXXX",
  "verificationUri": "https://github.com/login/device",
  "verificationUriComplete": "https://github.com/login/device?user_code=XXXX-XXXX",
  "expiresIn": 900,
  "interval": 5
}
```

**`POST /oauth/device/poll`**

Polls for device authorization completion.

**Request:**
```json
{
  "deviceCode": "device_code_from_start"
}
```

**Response (pending - 202):**
```json
{
  "status": "authorization_pending",
  "errorDescription": "The authorization request is still pending",
  "retryAfter": 5
}
```

**Response (success - 200):**
```json
{
  "accessToken": "gho_...",
  "refreshToken": "optional_refresh_token",
  "expiresIn": 28800,
  "scope": "repo read:user",
  "tokenType": "bearer"
}
```

**Response (error - 400):**
```json
{
  "status": "access_denied",
  "errorDescription": "The user denied the authorization request"
}
```

---

## Environment Configuration

Configure in `wrangler.toml` or via Cloudflare dashboard:

**Variables (non-secret):**
- `ISSUETRIAGE_GITHUB_CLIENT_ID`: GitHub OAuth app client ID
- `OPENROUTER_API_BASE`: OpenRouter API base URL (default: https://openrouter.ai/api/v1)
- `OPENROUTER_SITE_URL`: Referer header for OpenRouter (default: https://issuetriage.com)
- `OPENROUTER_APP_NAME`: App name header for OpenRouter (default: issuetriage)
- `GITHUB_AUTHORIZE_URL`: GitHub authorize endpoint (default: https://github.com/login/oauth/authorize)
- `GITHUB_TOKEN_URL`: GitHub token endpoint (default: https://github.com/login/oauth/access_token)
- `GITHUB_DEVICE_CODE_URL`: GitHub device code endpoint (default: https://github.com/login/device/code)

**Secrets (via `npx wrangler secret put`):**
- `ISSUETRIAGE_OPENROUTER_API_KEY`: OpenRouter API key
- `ISSUETRIAGE_GITHUB_CLIENT_SECRET`: GitHub OAuth app client secret

---

## Security Features

- **Server-side secrets**: API keys and OAuth secrets never exposed to clients
- **HMAC state signing**: OAuth web flow uses cryptographically signed state tokens
- **Constant-time comparison**: State verification uses timing-attack resistant comparison
- **Type validation**: All inputs validated and sanitized before proxying
