process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'test-session-secret-that-is-long-enough-to-pass-32';
const SERVICE_TOKEN = 'test-service-token-long-enough-1234567890';

async function withServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-service-test-'));
  fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  const dataFile = path.join(dir, 'data', 'progress.json');
  const env = { NODE_ENV: 'test', SESSION_SECRET, ENABLE_DEV_TOOLS: 'true', CTF_SERVICE_TOKEN: SERVICE_TOKEN };
  const server = createHubServer({ baseDir: dir, dataFile, env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { baseUrl };
}

async function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await res.json();
  return { response: res, payload };
}

test('service callback rejects missing and invalid service tokens', async (t) => {
  const { baseUrl } = await withServer(t);
  const noToken = await post(`${baseUrl}/api/integrations/sanctuary-complete`, { teamId: 'TEAM-001' });
  assert.equal(noToken.response.status, 401);

  const badToken = await post(`${baseUrl}/api/integrations/sanctuary-complete`, { teamId: 'TEAM-001' }, 'wrong-token');
  assert.equal(badToken.response.status, 401);
});

test('service callback rejects a missing or unregistered team', async (t) => {
  const { baseUrl } = await withServer(t);
  const missing = await post(`${baseUrl}/api/integrations/sanctuary-complete`, {}, SERVICE_TOKEN);
  assert.equal(missing.response.status, 400);

  const unregistered = await post(`${baseUrl}/api/integrations/sanctuary-complete`, { teamId: 'NO-SUCH-TEAM' }, SERVICE_TOKEN);
  assert.equal(unregistered.response.status, 404);
});

test('service callback marks a sanctuary complete idempotently', async (t) => {
  const { baseUrl } = await withServer(t);
  await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 'TEAM-001', teamName: 'Signal Wardens' })
  });

  const first = await post(`${baseUrl}/api/integrations/sanctuary-complete`, { teamId: 'TEAM-001' }, SERVICE_TOKEN);
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.ok, true);

  const second = await post(`${baseUrl}/api/integrations/sanctuary-complete`, { teamId: 'TEAM-001' }, SERVICE_TOKEN);
  assert.equal(second.response.status, 200);
  assert.equal(second.payload.ok, true);
});