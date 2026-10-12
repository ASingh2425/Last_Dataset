const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'security-audit-secret-key-that-is-at-least-32-chars';

function getSampleCsv(multiplier = 0.5) {
  const samplePath = path.join(ROOT, 'server_data', 'sample_submission.csv');
  const lines = fs.readFileSync(samplePath, 'utf8').trim().split(/\r?\n/);
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length >= 2) {
      out.push(`${parts[0].trim()},${multiplier.toFixed(4)}`);
    }
  }
  return out.join('\n');
}

function getPerfectCsv() {
  const answersPath = path.join(ROOT, 'server_data', 'private_answers.csv');
  if (fs.existsSync(answersPath)) {
    return fs.readFileSync(answersPath, 'utf8');
  }
  return getSampleCsv(0.85);
}

async function withAuditServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-sec-audit-'));
  const dataFile = path.join(dir, 'progress.json');
  const server = createHubServer({
    baseDir: ROOT,
    dataFile,
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET,
      DISABLE_SUPABASE: 'true'
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { baseUrl, server };
}

test('Security Audit 1: Spoofed x-team-id without session returns 401 on evaluate and zone complete', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // 1. Evaluate with spoofed header
  const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM_TEAM'
    },
    body: JSON.stringify({ csvContent: getSampleCsv() })
  });
  assert.equal(evalRes.status, 401, 'Unauthenticated eval with x-team-id header must return 401');
  const evalData = await evalRes.json();
  assert.equal(evalData.error, 'AUTH_REQUIRED');

  // 2. Zone completion with spoofed header
  const zoneRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM_TEAM'
    },
    body: JSON.stringify({ zoneId: 'yellow' })
  });
  assert.equal(zoneRes.status, 401, 'Unauthenticated zone completion with x-team-id must return 401');

  // 3. Submissions query with spoofed header
  const subsRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { 'x-team-id': 'VICTIM_TEAM' }
  });
  assert.equal(subsRes.status, 401, 'Unauthenticated ml submissions query must return 401');

  // 4. Team progress query with spoofed header
  const progRes = await fetch(`${baseUrl}/api/team/progress?team=VICTIM_TEAM`, {
    headers: { 'x-team-id': 'VICTIM_TEAM' }
  });
  assert.equal(progRes.status, 401, 'Unauthenticated team progress query must return 401');
});

test('Security Audit 2: Authenticated Team A cannot pass body.teamId or x-team-id to consume Team B quota', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // Register Team A
  const regARes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'ATTACKER-A', teamName: 'Attacker Team' })
  });
  assert.equal(regARes.status, 200);
  const cookieA = regARes.headers.get('set-cookie')?.split(';')[0];

  // Register Team B
  const regBRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'VICTIM-B', teamName: 'Victim Team' })
  });
  assert.equal(regBRes.status, 200);
  const cookieB = regBRes.headers.get('set-cookie')?.split(';')[0];

  // Team A submits but passes body.teamId = 'VICTIM-B' and header x-team-id: VICTIM-B
  const evalRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-team-id': 'VICTIM-B',
      Cookie: cookieA
    },
    body: JSON.stringify({
      teamId: 'VICTIM-B',
      csvContent: getSampleCsv()
    })
  });
  assert.equal(evalRes.status, 200);
  const evalJson = await evalRes.json();
  assert.equal(evalJson.submissionsUsed, 1, 'Team A used 1 attempt');

  // Verify Team B's submission count is STILL 0
  const subBRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { Cookie: cookieB }
  });
  assert.equal(subBRes.status, 200);
  const subBJson = await subBRes.json();
  assert.equal(subBJson.submissionsUsed, 0, "Victim Team B quota must remain untouched (0/10)");
  assert.equal(subBJson.submissionsRemaining, 10);
});

test('Security Audit 3: Parallel quota race: 5 simultaneous submissions at attempt 9 result in exactly 1 success and 4 rejections with 429', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  // Register Team
  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'CONCURRENCY-TEAM', teamName: 'Speed Racers' })
  });
  assert.equal(regRes.status, 200);
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  const validCsv = getSampleCsv();

  // Burn 9 attempts sequentially
  for (let i = 1; i <= 9; i++) {
    const res = await fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ csvContent: validCsv })
    });
    assert.equal(res.status, 200, `Sequential attempt ${i}/10 must succeed`);
  }

  // Now 1 attempt remains. Send 5 simultaneous requests in parallel!
  const parallelRequests = Array.from({ length: 5 }, () =>
    fetch(`${baseUrl}/api/ml/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ csvContent: validCsv })
    })
  );

  const responses = await Promise.all(parallelRequests);
  const statuses = responses.map((r) => r.status);
  const successes = statuses.filter((s) => s === 200).length;
  const rejected429 = statuses.filter((s) => s === 429).length;

  assert.equal(successes, 1, 'Exactly ONE parallel submission must succeed when 1 slot remains');
  assert.equal(rejected429, 4, 'Exactly FOUR parallel submissions must be rejected with HTTP 429');

  // Verify total submissions in store is exactly 10
  const historyRes = await fetch(`${baseUrl}/api/ml/submissions`, {
    headers: { Cookie: cookie }
  });
  const historyJson = await historyRes.json();
  assert.equal(historyJson.submissionsUsed, 10, 'Submissions used must be strictly 10');
  assert.equal(historyJson.submissionsRemaining, 0, 'Submissions remaining must be strictly 0');
});

test('Security Audit 4: Static file traversal to /server_data/private_answers.csv and /.env returns 404/403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const pathsToTest = [
    '/server_data/private_answers.csv',
    '/.env',
    '/package.json',
    '/../server_data/private_answers.csv',
    '/..%2fserver_data%2fprivate_answers.csv',
    '/lib/hub.js'
  ];

  for (const testPath of pathsToTest) {
    const res = await fetch(baseUrl + testPath);
    assert.ok(
      res.status === 404 || res.status === 403,
      `Request to sensitive path ${testPath} must return 404 or 403 (got ${res.status})`
    );
    const text = await res.text();
    assert.ok(
      !text.includes('Sanctuary_ID,Survival_Probability') && !text.includes('SUPABASE_SERVICE_ROLE_KEY'),
      `Sensitive path ${testPath} must never disclose server content`
    );
  }
});

test('Security Audit 5: Direct zone completion bypass without prerequisite returns 403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'BYPASS-TEAM', teamName: 'Bypass Crew' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // Try to complete Blue directly without completing Sanctuary or Yellow first
  const blueBypass = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'blue' })
  });
  assert.equal(blueBypass.status, 403, 'Clearing Blue zone before Yellow must return 403');
  const blueJson = await blueBypass.json();
  assert.equal(blueJson.error, 'PREREQUISITE_NOT_MET');

  // Try to complete Red directly without completing Orange first
  const redBypass = await fetch(`${baseUrl}/api/red/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }
  });
  assert.equal(redBypass.status, 403, 'Clearing Red zone before Orange must return 403');
  const redJson = await redBypass.json();
  assert.equal(redJson.error, 'PREREQUISITE_NOT_MET');
});

test('Security Audit 6: Purple zone completion without qualifying R2 >= 0.80 ML submission returns 403', async (t) => {
  const { baseUrl } = await withAuditServer(t);

  const regRes = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'PURPLE-TEAM', teamName: 'Purple Aspirants' })
  });
  const cookie = regRes.headers.get('set-cookie')?.split(';')[0];

  // Clear Sanctuary -> Yellow -> Blue -> Orange -> Red legitimately
  for (const zone of ['sanctuary', 'yellow', 'blue', 'orange', 'red']) {
    const res = await fetch(`${baseUrl}/api/zone/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ zoneId: zone })
    });
    assert.equal(res.status, 200, `Clearing prerequisite zone ${zone} must succeed`);
  }

  // Now Red is complete. Attempt to clear Purple directly without an approved ML submission
  const purpleDirectRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'purple' })
  });
  assert.equal(purpleDirectRes.status, 403, 'Purple zone complete without qualifying submission must return 403');
  const purpleJson = await purpleDirectRes.json();
  assert.equal(purpleJson.error, 'PREREQUISITE_NOT_MET');

  // Now submit an ML submission with poor score (R2 ~ 0.50 < 0.80)
  const lowScoreRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: getSampleCsv(0.5) })
  });
  assert.equal(lowScoreRes.status, 200);
  const lowScoreJson = await lowScoreRes.json();
  assert.equal(lowScoreJson.qualifiesForEscape, false);

  // Still cannot clear Purple
  const purpleAfterLowRes = await fetch(`${baseUrl}/api/zone/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ zoneId: 'purple' })
  });
  assert.equal(purpleAfterLowRes.status, 403, 'Purple zone complete with non-qualifying submission must return 403');

  // Submit winning ML submission
  const winningCsv = getPerfectCsv();
  const winScoreRes = await fetch(`${baseUrl}/api/ml/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ csvContent: winningCsv })
  });
  assert.equal(winScoreRes.status, 200);
  const winScoreJson = await winScoreRes.json();
  assert.ok(winScoreJson.qualifiesForEscape, 'Winning model qualifies for escape');

  // Purple zone can now be verified complete
  const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { Cookie: cookie }
  });
  const bootJson = await bootRes.json();
  assert.ok(bootJson.ml.escapeUnlocked, 'Escape Gate must be unlocked');
});
