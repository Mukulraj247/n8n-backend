# backend-n8n — JobRight session service

A tiny standalone service that logs into **JobRight** with a headless browser
(Playwright) and hands a fresh, authenticated `SESSION_ID` cookie to the n8n
**JobRight AI Jobs Ingestion** workflow.

JobRight gates the "Original Job Post" / apply URL behind login, and the login
cookie can't be minted with plain HTTP calls (it's created inside JobRight's
client JavaScript). This service drives a real browser to log in, so the n8n
workflow can stay hands-off — no more manually pasting tokens.

## How it works

```
n8n workflow ──GET /api/jobright/session──▶ backend-n8n ──Playwright login──▶ jobright.ai
     ▲                                              │
     └────────────── { sessionId } ◀───────────────┘  (cached ~in-memory)
```

- On first request it launches Chromium, opens `jobright.ai`, clicks **Sign in**,
  fills `#basic_email` / `#basic_password`, submits, and reads the resulting
  `SESSION_ID` cookie.
- The session is cached in memory and reused (JobRight sessions last ~60 days).
- It auto-refreshes when the cache TTL passes or the cookie nears expiry.

## Setup

```bash
cd backend-n8n
npm install            # also runs `playwright install chromium`
cp .env.example .env   # then edit credentials + secret
npm start
```

Test the login on its own:

```bash
npm run login:test
```

## API

### `GET /api/jobright/session`
Returns a valid authenticated session.

Headers: `x-api-key: <N8N_SHARED_SECRET>` (or `?key=<secret>`).

Query:
- `?force=true` — bypass cache and re-login.
- `?validate=true` — cheaply re-check a cached session and refresh if stale.

Response:
```json
{
  "sessionId": "e19510bd75324da9b24a0e6eafcc50cf",
  "expires": 1788315578572,
  "expiresIso": "2026-09-02T02:19:38.572Z",
  "source": "cache",
  "cachedAt": "2026-07-04T02:19:40.998Z"
}
```

### `GET /health`
Basic liveness + cache status.

## Wiring into the n8n workflow

The workflow `JobRight AI Jobs Ingestion (PROD)` already includes a
**`Get JobRight Session`** HTTP node inside the processing loop. Configure it:

1. Set its URL to `https://<your-backend-n8n-host>/api/jobright/session`.
2. Set the `x-api-key` header to your `N8N_SHARED_SECRET`.

The next node, **`JobRight Page (auth)`**, reads the cookie automatically via
`SESSION_ID={{ $json.sessionId }}`.

## Deploy on Render (Docker)

This repo includes a `Dockerfile` and `render.yaml`. Use Docker (not Render's
native Node env) because Chromium needs system libraries.

**Option A — Blueprint (render.yaml):**
1. Push `backend-n8n/` to a Git repo.
2. Render → **New → Blueprint** → pick the repo. It reads `render.yaml`.
3. When prompted, fill the secret env vars: `JOBRIGHT_EMAIL`, `JOBRIGHT_PASSWORD`
   (`N8N_SHARED_SECRET` is auto-generated — copy it for the n8n node).
4. Deploy. Your URL will be `https://backend-n8n-xxxx.onrender.com`.

**Option B — Manual:**
1. Render → **New → Web Service** → connect the repo.
2. Runtime: **Docker**. Health check path: `/health`.
3. Add env vars from `.env.example` (set `JOBRIGHT_EMAIL`, `JOBRIGHT_PASSWORD`,
   `N8N_SHARED_SECRET`).
4. Instance type: **Standard (2 GB)** recommended — Chromium can exceed the
   512 MB Free/Starter tiers and get OOM-killed.

**Important Render notes:**
- Do **not** set `PORT` — Render injects it and the server already reads
  `process.env.PORT`.
- **Free tier spins down** on inactivity; the first request after idle pays a
  cold start + ~8s login. Use Starter+ (always-on) if that matters, or have n8n
  retry once.
- After deploy, verify: `GET https://<your-app>.onrender.com/health` → `{"ok":true}`.

## Deployment notes (general)

- Must be reachable over HTTPS from n8n Cloud (public URL, tunnel, or same VPC).
- Container images must include Chromium deps (the provided `Dockerfile` runs
  `npx playwright install --with-deps chromium`).
- Keep `.env` out of version control (already in `.gitignore`).
