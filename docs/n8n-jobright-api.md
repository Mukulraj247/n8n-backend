# JobRight session + job scrape API (for n8n)

Use this backend when JobRight data must be fetched **from the same host that logged in**. JobRight binds `SESSION_ID` to the originating IP, so n8n Cloud cannot reliably scrape JobRight pages with a cookie minted here.

**Base URL:** `https://<your-backend-n8n-host>`  
**Auth:** every `/api/*` route needs the shared secret (see below).

---

## Auth

Send the secret on every API call:

| Method | How |
|--------|-----|
| Header (preferred) | `x-api-key: <N8N_SHARED_SECRET>` |
| Query (fallback) | `?key=<N8N_SHARED_SECRET>` |

Missing/wrong key → `401` `{ "error": "unauthorized" }`.

---

## 1. Get session cookie (optional)

Only needed if your workflow still attaches `SESSION_ID` itself. Prefer endpoint **#2** for apply URL + description.

```
GET /api/jobright/session
```

**Optional query**

| Param | Effect |
|-------|--------|
| `force=true` | Bypass cache; re-login with Playwright |
| `validate=true` | Re-check a cached session; refresh if stale |

**Example (n8n HTTP Request node)**

- Method: `GET`
- URL: `https://<host>/api/jobright/session`
- Header: `x-api-key` = `<N8N_SHARED_SECRET>`

**Success `200`**

```json
{
  "sessionId": "e19510bd75324da9b24a0e6eafcc50cf",
  "expires": 1788315578572,
  "expiresIso": "2026-09-02T02:19:38.572Z",
  "source": "cache",
  "cachedAt": "2026-07-04T02:19:40.998Z"
}
```

`source` is `"cache"` or `"fresh"`.

---

## 2. Scrape job details (use this)

Returns apply URL, normalized URL, job description, and related fields. Scraping runs **on this server**.

```
GET /api/jobright/job
```

Alias (same response):

```
GET /api/jobright/apply-url
```

**Query (one required)**

| Param | Example |
|-------|---------|
| `url` | `https://jobright.ai/jobs/info/6a470070c2d11a6a466714a2` |
| `jobId` | `6a470070c2d11a6a466714a2` |

**Example**

```
GET /api/jobright/job?url=https://jobright.ai/jobs/info/6a470070c2d11a6a466714a2
x-api-key: <N8N_SHARED_SECRET>
```

**Success `200`**

```json
{
  "jobId": "6a470070c2d11a6a466714a2",
  "jobTitle": "Software Engineer, New Grad",
  "jobUrl": "https://jobright.ai/jobs/info/6a470070c2d11a6a466714a2",
  "applyUrl": "https://boards.greenhouse.io/embed/job_app?token=8615717002&utm_source=jobright",
  "normalizedJobUrl": "https://boards.greenhouse.io/embed/job_app?token=8615717002",
  "jobDescription": "IXL Learning is the country's largest EdTech company...\n\nResponsibilities\n- Build the back-end...\n\nQualifications (must have)\n- Bachelor's...",
  "jobSummary": "IXL Learning is the country's largest EdTech company...",
  "jobLocation": "Raleigh, NC",
  "employmentType": "Full-time",
  "workModel": "Onsite",
  "isRemote": false,
  "companyLogo": "https://media.licdn.com/...",
  "publishTime": "2026-07-31 19:20:29",
  "coreResponsibilities": [
    "Build the back-end wiring, application logic, and UI that engage our users"
  ],
  "qualifications": {
    "mustHave": ["Bachelor's or advanced degree in computer science or a related discipline"],
    "preferredHave": ["Knowledge of Python"]
  },
  "sessionSource": "cache"
}
```

### Field mapping for n8n

| You asked for | Response field | Notes |
|---------------|----------------|-------|
| JobRight page URL | `jobUrl` | `https://jobright.ai/jobs/info/<jobId>` |
| Apply / original URL | `applyUrl` | From JobRight `applyLink` / `originalUrl` |
| Normalized apply URL | `normalizedJobUrl` | Tracking params (`utm_*`, etc.) stripped |
| Job description | `jobDescription` | Assembled text (see below) |
| Title | `jobTitle` | |
| Location / type | `jobLocation`, `employmentType`, `workModel`, `isRemote` | |
| Structured bullets | `coreResponsibilities`, `qualifications` | Prefer these if you need lists |

**About HTML:** JobRight does **not** expose a full HTML job description in page data. `jobDescription` is built from summary + responsibilities + qualifications (+ benefits when present). Use that instead of raw HTML.

**About `applyUrl`:** can be `null` even when scrape succeeds (rare / gated postings). You still get title/description when `loggedIn` worked; treat missing `applyUrl` in your workflow.

---

## 3. Health check

```
GET /health
```

No API key. Example: `{ "ok": true, "hasCache": true, "cacheValid": true }`.

---

## Suggested n8n wiring

1. **HTTP Request** → `GET /api/jobright/job?url={{ $json.jobrightUrl }}`
2. Header `x-api-key` = shared secret (credential / env).
3. Map:
   - `{{ $json.applyUrl }}`
   - `{{ $json.normalizedJobUrl }}`
   - `{{ $json.jobDescription }}`
   - `{{ $json.jobUrl }}`
   - `{{ $json.jobTitle }}`

You usually **do not** need a separate “get session” node if you only need scrape fields.

---

## Errors

| Status | Meaning |
|--------|---------|
| `400` | Missing `url` / `jobId` |
| `401` | Bad/missing API key |
| `500` | Server missing JobRight credentials |
| `502` | Login/scrape failed (session invalid or JobRight error). Body includes `error` + `message`. |

On stale session, the server auto re-logins **once** and retries the scrape.

---

## Ops notes

- Prefer always-on hosting (Render Free cold-starts + ~8s Playwright login on first hit).
- Session is cached in memory (~30 min TTL by default); restarts clear the cache.
- Keep `N8N_SHARED_SECRET` long and private; same value in this service and the n8n node.
