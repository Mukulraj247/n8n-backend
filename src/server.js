require('dotenv').config();
const express = require('express');
const { fetchJobRightSession, validateSessionHttp, getJobDetails } = require('./login');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const EMAIL = process.env.JOBRIGHT_EMAIL;
const PASSWORD = process.env.JOBRIGHT_PASSWORD;
const SHARED_SECRET = process.env.N8N_SHARED_SECRET || '';
// How long to trust a cached session before re-validating (default 30 min).
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '1800000', 10);
// Refresh this long before the cookie's own expiry (default 1 day).
const EXPIRY_BUFFER_MS = parseInt(process.env.EXPIRY_BUFFER_MS || '86400000', 10);

// ---- in-memory session cache ----
let cache = null; // { sessionId, expires, cachedAt }
let inFlight = null; // Promise dedupe for concurrent requests

function isCacheValid() {
  if (!cache) return false;
  const now = Date.now();
  if (now - cache.cachedAt > SESSION_TTL_MS) return false;
  if (cache.expires && now > cache.expires - EXPIRY_BUFFER_MS) return false;
  return true;
}

async function getSession(force) {
  if (!force && isCacheValid()) return { ...cache, source: 'cache' };
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const r = await fetchJobRightSession({ email: EMAIL, password: PASSWORD, headless: true });
    cache = { sessionId: r.sessionId, expires: r.expires, cachedAt: Date.now() };
    return { ...cache, source: 'fresh' };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function requireSecret(req, res, next) {
  if (!SHARED_SECRET) return next(); // no secret configured -> open (dev only)
  const key = req.get('x-api-key') || req.query.key;
  if (key !== SHARED_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, hasCache: !!cache, cacheValid: isCacheValid() });
});

/**
 * GET /api/jobright/session
 * Returns a valid authenticated SESSION_ID (cached, refreshed automatically).
 * Query: ?force=true to bypass cache and re-login.
 */
app.get('/api/jobright/session', requireSecret, async (req, res) => {
  try {
    if (!EMAIL || !PASSWORD) {
      return res.status(500).json({ error: 'JOBRIGHT_EMAIL / JOBRIGHT_PASSWORD not configured' });
    }
    const force = req.query.force === 'true' || req.query.force === '1';
    let result = await getSession(force);

    // Safety net: if a cached session went stale early, re-validate cheaply and refresh.
    if (result.source === 'cache' && req.query.validate === 'true') {
      const ok = await validateSessionHttp(result.sessionId).catch(() => false);
      if (!ok) {
        cache = null;
        result = await getSession(true);
      }
    }

    res.json({
      sessionId: result.sessionId,
      expires: result.expires,
      expiresIso: result.expires ? new Date(result.expires).toISOString() : null,
      source: result.source,
      cachedAt: new Date(result.cachedAt).toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: 'login_failed', message: e.message });
  }
});

/**
 * Shared handler: scrape JobRight job details (apply URL, description, etc.).
 * Fetch runs HERE (same IP as login) because JobRight binds sessions to IP.
 */
async function handleJobDetails(req, res) {
  try {
    if (!EMAIL || !PASSWORD) {
      return res.status(500).json({ error: 'JOBRIGHT_EMAIL / JOBRIGHT_PASSWORD not configured' });
    }
    const jobRef = req.query.url || req.query.jobId;
    if (!jobRef) return res.status(400).json({ error: 'missing url or jobId query param' });

    let sess = await getSession(false);
    let result = await getJobDetails(sess.sessionId, jobRef);

    // Session stale for this IP -> force a fresh login once and retry.
    if (!result.loggedIn) {
      cache = null;
      sess = await getSession(true);
      result = await getJobDetails(sess.sessionId, jobRef);
    }

    if (!result.loggedIn) {
      return res.status(502).json({
        error: 'job_scrape_failed',
        loggedIn: false,
        jobId: result.jobId,
        message: 'Could not authenticate the JobRight session (login may be failing).',
      });
    }

    res.json({
      jobId: result.jobId,
      jobTitle: result.jobTitle,
      jobUrl: result.jobUrl,
      applyUrl: result.applyUrl,
      normalizedJobUrl: result.normalizedJobUrl,
      jobDescription: result.jobDescription,
      jobSummary: result.jobSummary,
      jobLocation: result.jobLocation,
      employmentType: result.employmentType,
      workModel: result.workModel,
      isRemote: result.isRemote,
      companyLogo: result.companyLogo,
      publishTime: result.publishTime,
      coreResponsibilities: result.coreResponsibilities,
      qualifications: result.qualifications,
      sessionSource: sess.source,
    });
  } catch (e) {
    res.status(502).json({ error: 'job_scrape_failed', message: e.message });
  }
}

/**
 * GET /api/jobright/apply-url?url=<jobright job url>  (or ?jobId=<id>)
 * Also available as GET /api/jobright/job (same payload).
 */
app.get('/api/jobright/apply-url', requireSecret, handleJobDetails);
app.get('/api/jobright/job', requireSecret, handleJobDetails);

app.listen(PORT, () => {
  console.log(`backend-n8n listening on http://localhost:${PORT}`);
  console.log(`  GET /api/jobright/session`);
  console.log(`  GET /api/jobright/job?url=<jobUrl>  (alias: /api/jobright/apply-url)`);
  console.log(`  (x-api-key required: ${SHARED_SECRET ? 'yes' : 'NO - set N8N_SHARED_SECRET'})`);
});
