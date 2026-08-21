const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function readSessionId(cookies) {
  const c = cookies.find((x) => x.name === 'SESSION_ID');
  return c ? c.value : null;
}

/**
 * Logs into JobRight with email/password via a headless browser and returns a
 * fresh authenticated SESSION_ID cookie (plus its expiry, if provided).
 *
 * @param {{email:string,password:string,headless?:boolean,timeoutMs?:number}} opts
 * @returns {Promise<{sessionId:string,expires:number|null,cookies:object[]}>}
 */
async function fetchJobRightSession(opts) {
  const { email, password, headless = true, timeoutMs = 60000 } = opts;
  if (!email || !password) throw new Error('email and password are required');

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();

    await page.goto('https://jobright.ai/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1500);

    // Open the sign-in modal (header "Sign in" / "SIGN IN").
    await page.getByText(/^sign in$/i).first().click({ timeout: 20000 });

    // Wait for the email/password form to render.
    await page.waitForSelector('#basic_email', { timeout: 20000 });
    await page.fill('#basic_email', email);
    await page.fill('#basic_password', password);

    // Capture the login API response so we know the attempt actually succeeded.
    const loginResponse = page
      .waitForResponse(
        (r) => /\/swan\/auth\/login/i.test(r.url()) || /\/swan\/.*login/i.test(r.url()),
        { timeout: timeoutMs }
      )
      .catch(() => null);

    // Click the modal's SIGN IN submit button (not the search "GO" submit).
    await page.locator('button[type="submit"]:has-text("SIGN IN")').first().click({ timeout: 20000 });

    const resp = await loginResponse;
    if (resp) {
      let bodyText = '';
      try { bodyText = await resp.text(); } catch (e) { /* ignore */ }
      if (/"success"\s*:\s*false/i.test(bodyText)) {
        throw new Error('JobRight login failed: ' + bodyText.slice(0, 200));
      }
    }

    // Poll for the authenticated SESSION_ID cookie.
    const deadline = Date.now() + timeoutMs;
    let sessionId = null;
    let cookies = [];
    while (Date.now() < deadline) {
      cookies = await ctx.cookies('https://jobright.ai');
      sessionId = readSessionId(cookies);
      if (sessionId) {
        // Confirm the session is actually authenticated by loading a gated page.
        const ok = await verifyAuthenticated(ctx, sessionId).catch(() => false);
        if (ok) break;
      }
      await page.waitForTimeout(1000);
    }

    if (!sessionId) throw new Error('Login completed but no SESSION_ID cookie was set');

    const cookie = cookies.find((x) => x.name === 'SESSION_ID');
    return {
      sessionId,
      expires: cookie && cookie.expires && cookie.expires > 0 ? Math.round(cookie.expires * 1000) : null,
      cookies,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Verifies a SESSION_ID is authenticated by requesting a job page and checking
 * that the embedded __NEXT_DATA__ contains an applyLink/originalUrl.
 */
async function verifyAuthenticated(ctx, sessionId, jobId) {
  const id = jobId || '6a470070c2d11a6a466714a2';
  const api = await ctx.request.get('https://jobright.ai/jobs/info/' + id, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  if (!api.ok()) return false;
  const html = await api.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return false;
  try {
    const nd = JSON.parse(m[1]);
    const jr = nd?.props?.pageProps?.dataSource?.jobResult;
    return !!(jr && (jr.applyLink || jr.originalUrl));
  } catch (e) {
    return false;
  }
}

/** Extract the JobRight job id from a full job URL. */
function extractJobId(jobUrlOrId) {
  const s = String(jobUrlOrId || '').trim();
  if (!s) return '';
  if (!s.includes('/')) return s; // already an id
  return s.split('?')[0].replace(/\/+$/, '').split('/').pop();
}

/**
 * Server-side (no-browser) fetch of a JobRight job page using a SESSION_ID.
 * IMPORTANT: JobRight binds sessions to the originating IP, so this MUST run on
 * the same host/IP that performed the login.
 * Resolves the parsed `jobResult` object, or null if not logged in / not found.
 */
function fetchJobResultHttp(sessionId, jobUrlOrId) {
  const https = require('https');
  const id = extractJobId(jobUrlOrId) || '6a470070c2d11a6a466714a2';
  return new Promise((resolve) => {
    const req = https.get(
      {
        host: 'jobright.ai',
        path: '/jobs/info/' + id,
        headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: 'SESSION_ID=' + sessionId },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          const m = d.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (!m) return resolve(null);
          try {
            resolve(JSON.parse(m[1])?.props?.pageProps?.dataSource?.jobResult || null);
          } catch (e) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(25000, () => { req.destroy(); resolve(null); });
  });
}

/** True if the SESSION_ID currently authenticates (job data has an apply URL). */
async function validateSessionHttp(sessionId, jobId) {
  const jr = await fetchJobResultHttp(sessionId, jobId);
  return !!(jr && (jr.applyLink || jr.originalUrl));
}

/** Strip common tracking/query noise from an apply URL. */
function normalizeJobUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const drop = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_id',
      'ref',
      'source',
      'gh_src',
    ];
    for (const k of drop) u.searchParams.delete(k);
    const qs = u.searchParams.toString();
    return u.origin + u.pathname + (qs ? '?' + qs : '') + u.hash;
  } catch (e) {
    return url;
  }
}

function bulletBlock(title, items) {
  if (!items || !items.length) return '';
  return title + '\n' + items.map((x) => '- ' + String(x)).join('\n');
}

/**
 * Build a readable job description from JobRight's structured jobResult fields
 * (JobRight does not expose a single full HTML JD in __NEXT_DATA__).
 */
function buildJobDescription(jr) {
  if (!jr) return null;
  const parts = [];
  if (jr.jobSummary) parts.push(String(jr.jobSummary).trim());
  if (jr.jdResponsibilitySummary) parts.push(String(jr.jdResponsibilitySummary).trim());

  const resp = bulletBlock('Responsibilities', jr.coreResponsibilities);
  if (resp) parts.push(resp);

  const must = jr.qualifications && jr.qualifications.mustHave;
  const pref = jr.qualifications && jr.qualifications.preferredHave;
  const mustBlock = bulletBlock('Qualifications (must have)', must);
  if (mustBlock) parts.push(mustBlock);
  const prefBlock = bulletBlock('Qualifications (preferred)', pref);
  if (prefBlock) parts.push(prefBlock);

  const benefits = bulletBlock('Benefits', jr.benefitsSummaries);
  if (benefits) parts.push(benefits);
  if (jr.whyJoinUs) parts.push('Why join us\n' + String(jr.whyJoinUs).trim());

  const text = parts.filter(Boolean).join('\n\n').trim();
  return text || null;
}

/**
 * Scrape main job details from a JobRight job page using SESSION_ID.
 * `loggedIn` is false when the page rendered logged-out (session invalid for this IP).
 */
async function getJobDetails(sessionId, jobUrlOrId) {
  const fallbackId = extractJobId(jobUrlOrId);
  const jr = await fetchJobResultHttp(sessionId, jobUrlOrId);
  if (!jr) {
    return {
      loggedIn: false,
      jobId: fallbackId || null,
      jobTitle: null,
      jobUrl: fallbackId ? 'https://jobright.ai/jobs/info/' + fallbackId : null,
      applyUrl: null,
      normalizedJobUrl: null,
      jobDescription: null,
      jobSummary: null,
      jobLocation: null,
      employmentType: null,
      workModel: null,
      companyLogo: null,
      publishTime: null,
      coreResponsibilities: null,
      qualifications: null,
    };
  }

  const jobId = jr.jobId || fallbackId || null;
  const applyUrl = jr.applyLink || jr.originalUrl || null;
  const jobUrl = jobId ? 'https://jobright.ai/jobs/info/' + jobId : null;

  return {
    loggedIn: true,
    jobId,
    jobTitle: jr.jobTitle || jr.jobNlpTitle || null,
    jobUrl,
    applyUrl,
    normalizedJobUrl: normalizeJobUrl(applyUrl),
    jobDescription: buildJobDescription(jr),
    jobSummary: jr.jobSummary || null,
    jobLocation: jr.jobLocation || null,
    employmentType: jr.employmentType || null,
    workModel: jr.workModel || null,
    companyLogo: jr.jdLogo || null,
    publishTime: jr.publishTime || null,
    isRemote: !!jr.isRemote,
    coreResponsibilities: Array.isArray(jr.coreResponsibilities) ? jr.coreResponsibilities : null,
    qualifications: jr.qualifications || null,
  };
}

/**
 * Returns apply URL + title for a job using a SESSION_ID (thin wrapper).
 */
async function getApplyUrl(sessionId, jobUrlOrId) {
  const d = await getJobDetails(sessionId, jobUrlOrId);
  return {
    applyUrl: d.applyUrl,
    jobTitle: d.jobTitle,
    jobId: d.jobId,
    loggedIn: d.loggedIn,
  };
}

module.exports = {
  fetchJobRightSession,
  verifyAuthenticated,
  validateSessionHttp,
  fetchJobResultHttp,
  getApplyUrl,
  getJobDetails,
  buildJobDescription,
  normalizeJobUrl,
  extractJobId,
};
