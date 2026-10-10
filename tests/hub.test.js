const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHubServer } = require('../lib/hub');
const { hmac } = require('../lib/security');
const ROOT = path.resolve(__dirname, '..');
const SESSION_SECRET = 'test-session-secret-that-is-long-enough-to-pass-32';
const CTF_SECRET = 'test-yellow-03-ctf-secret-never-use-in-production';

async function withServer(t, configMode = 'open') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-hub-test-'));
  fs.cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  const teamsFile = path.join(dir, 'config', 'teams.json');
  const teams = JSON.parse(fs.readFileSync(teamsFile, 'utf8'));
  teams.mode = configMode;
  if (configMode === 'whitelist') teams.allowedIds = ['ALLOW-01'];
  fs.writeFileSync(teamsFile, JSON.stringify(teams, null, 2));
  const env = { NODE_ENV: 'test', ENABLE_DEV_TOOLS: 'true', SESSION_SECRET, CTF_SECRET_YELLOW_03: CTF_SECRET };
  const server = createHubServer({ baseDir: dir, dataFile: path.join(dir, 'data', 'progress.json'), env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function req(route, { method = 'GET', body, cookie } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  }
  return { server, baseUrl, req };
}

test('registration, team-name locking, locked-zone enforcement, and ordered unlock', async (t) => {
  const { req } = await withServer(t);
  let result = await req('/api/bootstrap');
  assert.equal(result.payload.authenticated, false);
  result = await req('/api/bootstrap', { cookie: 'td_session=%E0%A4%A' });
  assert.equal(result.response.status, 200, 'malformed percent escapes in cookies must not crash the request handler');
  assert.equal(result.payload.authenticated, false);
  assert.equal(JSON.stringify(result.payload).includes('yellow-01'), false, 'CTF IDs should not be in public bootstrap');
  result = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-007', teamName: '<script>alert(1)</script>' } });
  assert.equal(result.response.status, 400, 'XSS markup should be rejected by name validation');
  result = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-007', teamName: 'Signal Wardens' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.authenticated, true);
  const cookie = result.cookie;
  assert.match(cookie, /^td_session=[a-f0-9]{64}\.[a-f0-9]{64}$/);
  result = await req('/api/register', { method: 'POST', cookie, body: { teamId: 'TEAM-007', teamName: 'Not The Same Team' } });
  assert.equal(result.response.status, 409, 'existing name must not be overwritten');
  result = await req('/api/zones/blue', { cookie });
  assert.equal(result.response.status, 403);
  result = await req('/api/ctfs/blue-01/open', { method: 'POST', body: {}, cookie });
  assert.equal(result.response.status, 403);
  result = await req('/api/bootstrap', { cookie });
  assert.equal(result.payload.zones.find((zone) => zone.id === 'blue').unlocked, false);
  assert.equal(JSON.stringify(result.payload).includes('/mock/ctf/blue-01'), false, 'locked URLs must not be sent to the client');
  for (const ctfId of ['yellow-01', 'yellow-02']) {
    result = await req('/api/dev/solve', { method: 'POST', body: { ctfId }, cookie });
    assert.equal(result.response.status, 200);
  }
  result = await req('/api/zones/blue', { cookie });
  assert.equal(result.response.status, 403, 'partial zone completion must not unlock next zone');
});

test('signed completion verifies HMAC, expires timestamps, rejects replay, and unlocks in sequence', async (t) => {
  const { req } = await withServer(t);
  let registered = await req('/api/register', { method: 'POST', body: { teamId: 'TEAM-03', teamName: 'Archive Keepers' } });
  const cookie = registered.cookie;
  for (const ctfId of ['yellow-01', 'yellow-02']) await req('/api/dev/solve', { method: 'POST', body: { ctfId }, cookie });
  const now = Math.floor(Date.now() / 1000);
  const baseBody = { teamId: 'team-03', ctfId: 'yellow-03', timestamp: now };
  let response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature: '0'.repeat(64) } });
  assert.equal(response.response.status, 401);
  const expired = now - 900;
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, timestamp: expired, signature: hmac(CTF_SECRET, `TEAM-03.yellow-03.${expired}`) } });
  assert.equal(response.response.status, 401);
  const wrongSecretSignature = hmac('completely-wrong-secret-that-is-long-enough', `TEAM-03.yellow-03.${now}`);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature: wrongSecretSignature } });
  assert.equal(response.response.status, 401, 'a signature from the wrong secret must be rejected');
  const signature = hmac(CTF_SECRET, `TEAM-03.yellow-03.${now}`);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature } });
  assert.equal(response.response.status, 200);
  assert.equal(response.payload.newlySolved, true);
  const nextTimestamp = now + 1;
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, timestamp: nextTimestamp, signature: hmac(CTF_SECRET, `TEAM-03.yellow-03.${nextTimestamp}`) } });
  assert.equal(response.response.status, 200, 'freshly signed duplicate completions should be idempotent');
  assert.equal(response.payload.newlySolved, false);
  response = await req('/api/internal/complete', { method: 'POST', body: { ...baseBody, signature } });
  assert.equal(response.response.status, 409, 'exact signed request replay must be rejected');
  response = await req('/api/zones/blue', { cookie });
  assert.equal(response.response.status, 200, 'Blue unlocks after all Yellow challenges are complete');
  assert.equal(response.payload.ctfs.length, 3);
});

test('whitelist mode rejects unlisted IDs and allows listed IDs', async (t) => {
  const { req } = await withServer(t, 'whitelist');
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'BLOCK-01', teamName: 'Field Team' } });
  assert.equal(result.response.status, 403);
  result = await req('/api/register', { method: 'POST', body: { teamId: 'ALLOW-01', teamName: 'Field Team' } });
  assert.equal(result.response.status, 200);
});

test('dev simulation route is absent in production', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-prod-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NODE_ENV: 'production', SESSION_SECRET: 'production-test-secret-is-long-and-not-default', ENABLE_DEV_TOOLS: 'true', COOKIE_SECURE: 'false' };
  const server = createHubServer({ baseDir: ROOT, dataFile: path.join(dir, 'progress.json'), env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dev/solve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ctfId: 'yellow-01' }) });
  assert.equal(response.status, 404);
  assert.equal(server.hub.devToolsEnabled, false);
});


test('returning teams restore server-side progress under the original name', async (t) => {
  const { req } = await withServer(t);
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'RESUME-01', teamName: 'Signal Keepers' } });
  assert.equal(result.response.status, 200);
  const firstCookie = result.cookie;
  result = await req('/api/dev/solve', { method: 'POST', body: { ctfId: 'yellow-01' }, cookie: firstCookie });
  assert.equal(result.response.status, 200);
  result = await req('/api/register', { method: 'POST', body: { teamId: 'resume-01', teamName: 'Signal Keepers' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.team.id, 'RESUME-01');
  assert.equal(result.payload.progress.solved, 1);
  assert.equal(result.payload.zones.find((zone) => zone.id === 'yellow').state, 'in-progress');
});

test('all five zones clear in strict order and produce survivor-complete progress', async (t) => {
  const { req } = await withServer(t);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'zones.json'), 'utf8'));
  let result = await req('/api/register', { method: 'POST', body: { teamId: 'FULL-RUN-01', teamName: 'The Last Archive' } });
  const cookie = result.cookie;
  for (const zone of config.zones) {
    result = await req(`/api/zones/${zone.id}`, { cookie });
    assert.equal(result.response.status, 200, `${zone.id} should unlock after the previous zone clears`);
    for (const ctf of zone.ctfs) {
      result = await req('/api/dev/solve', { method: 'POST', body: { ctfId: ctf.id }, cookie });
      assert.equal(result.response.status, 200, `${ctf.id} should be completable when its zone is open`);
    }
  }
  result = await req('/api/bootstrap', { cookie });
  assert.equal(result.payload.progress.solved, 15);
  assert.equal(result.payload.progress.complete, true);
  assert.ok(result.payload.zones.every((zone) => zone.state === 'cleared'));
});
