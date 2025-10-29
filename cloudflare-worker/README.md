# IssueTriage Cloudflare Worker

Use this Worker to proxy LLM requests so secrets stay on the server.

1. Install dependencies: `npm install`
2. Store secrets: `npx wrangler secret put ISSUETRIAGE_OPENROUTER_API_KEY`
3. Start locally: `npm run dev`
4. Deploy to Cloudflare: `npm run deploy`

`POST /llm` forwards the body to OpenRouter using the `ISSUETRIAGE_OPENROUTER_API_KEY` secret. Optional vars `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` populate the recommended headers for OpenRouter usage.

OAuth helpers:
- `GET /oauth/authorize?redirect_uri=<url>&scope=<optional>` returns a signed state and GitHub authorization URL.
- `POST /oauth/exchange` with `{ "code": "...", "state": "...", "redirectUri": "..." }` trades the GitHub code for an access token.

Configure GitHub bindings via `ISSUETRIAGE_GITHUB_CLIENT_ID` (env var) and the `ISSUETRIAGE_GITHUB_CLIENT_SECRET` secret (`npx wrangler secret put ISSUETRIAGE_GITHUB_CLIENT_SECRET`).
