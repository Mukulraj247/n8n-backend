require('dotenv').config();
const { fetchJobRightSession } = require('./login');

(async () => {
  const email = process.env.JOBRIGHT_EMAIL;
  const password = process.env.JOBRIGHT_PASSWORD;
  const headless = process.env.HEADLESS !== 'false';
  console.log('Logging in as', email, '(headless=' + headless + ') ...');
  const t = Date.now();
  try {
    const r = await fetchJobRightSession({ email, password, headless });
    console.log('SUCCESS in', ((Date.now() - t) / 1000).toFixed(1) + 's');
    console.log('SESSION_ID:', r.sessionId);
    console.log('expires:', r.expires ? new Date(r.expires).toISOString() : '(session cookie / unknown)');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
