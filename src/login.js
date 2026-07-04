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

/**
 * Lightweight (no-browser) validation: fetch a job page with the given
 * SESSION_ID over plain HTTPS and confirm the authenticated data is present.
 */
function validateSessionHttp(sessionId, jobId) {
  const https = require('https');
  const id = jobId || '6a470070c2d11a6a466714a2';
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
          if (!m) return resolve(false);
          try {
            const jr = JSON.parse(m[1])?.props?.pageProps?.dataSource?.jobResult;
            resolve(!!(jr && (jr.applyLink || jr.originalUrl)));
          } catch (e) {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(20000, () => { req.destroy(); resolve(false); });
  });
}

module.exports = { fetchJobRightSession, verifyAuthenticated, validateSessionHttp };
