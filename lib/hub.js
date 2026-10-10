const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { loadConfig } = require('./config');
const { createStore, createUpstashStore } = require('./store');
const {
  hmac, safeEqual, signSession, verifySessionCookie, randomId,
  validateTeamId, validateTeamName, canonicalTeamId, sanitizeTeamName, validCtfSignature
} = require('./security');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};
const MAX_BODY = 64 * 1024;

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function appendEvent(team, message) {
  team.events ||= [];
  team.events.unshift({ message, at: new Date().toISOString() });
  team.events = team.events.slice(0, 40);
}
function createHubServer(options = {}) {
  const baseDir = options.baseDir || path.resolve(__dirname, '..');
  const publicDir = path.join(baseDir, 'public');
  const config = loadConfig(baseDir);
  const env = { ...process.env, ...(options.env || {}) };
  const envFile = path.join(baseDir, '.env');
  if (!options.env && fs.existsSync(envFile)) {
    // Small dotenv reader; values are never exposed to client responses.
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const isProduction = env.NODE_ENV === 'production';
  const devToolsEnabled = !isProduction && env.ENABLE_DEV_TOOLS === 'true';
  if (isProduction && (!env.SESSION_SECRET || env.SESSION_SECRET === 'replace-with-at-least-32-random-bytes' || env.SESSION_SECRET.length < 32)) {
    throw new Error('Production requires SESSION_SECRET with at least 32 characters.');
  }
  const sessionSecret = env.SESSION_SECRET || 'development-only-session-secret-change-before-deploy-4f89a6b3';
  const store = options.store || (env.VERCEL ? createUpstashStore(env) : createStore(options.dataFile || env.DATA_FILE || path.join(baseDir, 'data', 'progress.json')));
  const rates = new Map();
  const staticRoot = path.resolve(publicDir) + path.sep;

  function isAllowedZone(team, zoneId) {
    const index = config.zones.findIndex((zone) => zone.id === zoneId);
    if (index < 0) return false;
    if (index === 0) return true;
    const previous = config.zones[index - 1];
    return previous.ctfs.every((ctf) => team.solvedCtfs.includes(ctf.id));
  }
  function allSolved(team, zone) { return zone.ctfs.every((ctf) => team.solvedCtfs.includes(ctf.id)); }
  function zoneState(team, zone) {
    const index = config.zones.findIndex((item) => item.id === zone.id);
    const unlocked = isAllowedZone(team, zone.id);
    const solved = zone.ctfs.filter((ctf) => team.solvedCtfs.includes(ctf.id)).length;
    const state = !unlocked ? 'locked' : solved === zone.ctfs.length ? 'cleared' : solved > 0 ? 'in-progress' : 'available';
    return { id: zone.id, name: zone.name, color: zone.color, order: zone.order, tagline: zone.tagline, terrain: zone.terrain, position: zone.position, ctfTotal: zone.ctfs.length, solved, state, unlocked, isFinal: index === config.zones.length - 1 };
  }
  function getBootstrap(team, session, state) {
    const zones = config.zones.map((zone) => zoneState(team, zone));
    const totalCtfs = config.zones.reduce((sum, zone) => sum + zone.ctfs.length, 0);
    const solved = team.solvedCtfs.length;
    return {
      authenticated: true,
      team: { id: team.id, name: team.name, createdAt: team.createdAt },
      progress: { solved, total: totalCtfs, ratio: totalCtfs ? solved / totalCtfs : 0, complete: solved === totalCtfs },
      zones,
      event: config.event,
      events: team.events || [],
      view: session.view || { screen: 'map' },
      devToolsEnabled,
      serverTime: new Date().toISOString()
    };
  }
  function publicBootstrap() {
    return {
      authenticated: false,
      zones: config.zones.map((zone) => ({ id: zone.id, name: zone.name, color: zone.color, order: zone.order, tagline: zone.tagline, terrain: zone.terrain, position: zone.position, ctfTotal: zone.ctfs.length, solved: 0, state: zone.order === 1 ? 'available' : 'locked', unlocked: zone.order === 1 })),
      event: config.event,
      devToolsEnabled,
      serverTime: new Date().toISOString()
    };
  }
  function setSessionCookie(res, sessionId) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=${signSession(sessionId, sessionSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
  }
  function clearSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
  }
  async function sessionContext(req) {
    // Cookie values are opaque tokens; do not URI-decode them. Apart from being unnecessary
    // for our hex/base64url-safe session cookie, decoding malformed percent escapes can throw
    // before the request's error handler gets control.
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('='); return index < 0 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
    }).filter(([name]) => name));
    const sid = verifySessionCookie(cookies.td_session, sessionSecret);
    if (!sid) return { sid: null, session: null, team: null, state: null };
    const state = await store.read();
    const session = state.sessions[sid];
    if (!session || !state.teams[session.teamId]) return { sid: null, session: null, team: null, state };
    const created = Date.parse(session.createdAt || 0);
    if (!Number.isFinite(created) || Date.now() - created > 7 * 24 * 60 * 60 * 1000) { delete state.sessions[sid]; await store.write(state); return { sid: null, session: null, team: null, state }; }
    session.lastSeen = new Date().toISOString();
    return { sid, session, team: state.teams[session.teamId], state };
  }
  function rateLimit(req, key, max, windowMs) {
    const now = Date.now();
    const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const id = `${ip}|${key}`;
    let item = rates.get(id);
    if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
    item.count += 1; rates.set(id, item);
    if (rates.size > 10000) for (const [k, v] of rates) if (now - v.start > 60 * 60 * 1000) rates.delete(k);
    return item.count <= max;
  }
  function sessionRateLimit(sid, group, max, windowMs) {
    if (!sid) return true;
    return rateLimit({ socket: { remoteAddress: `session-${sid}` } }, `session:${group}`, max, windowMs);
  }
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/json') throw Object.assign(new Error('JSON required'), { status: 415 });
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Malformed JSON'), { status: 400 }); }
  }
  function commonHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  }
  function requireTeam(ctx, res) {
    if (!ctx.team) { json(res, 401, { error: 'AUTH_REQUIRED', message: 'Return to the Sanctuary gate and identify your team.' }); return false; }
    return true;
  }
  function completeCtf(state, team, ctf, sourceLabel = 'DATA RECOVERED') {
    if (team.solvedCtfs.includes(ctf.id)) return false;
    team.solvedCtfs.push(ctf.id);
    appendEvent(team, `${sourceLabel}: ${ctf.title}`);
    return true;
  }
  function findCtf(ctfId) {
    for (const zone of config.zones) {
      const ctf = zone.ctfs.find((item) => item.id === ctfId);
      if (ctf) return { zone, ctf };
    }
    return null;
  }

  const handler = async (req, res) => {
    commonHeaders(res);
    let releaseStoreLock = null;
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const initialPath = decodeURIComponent(url.pathname);
      // State operations must be serialized across serverless instances as well as locally.
      const needsSession = (initialPath.startsWith('/api/') && initialPath !== '/api/health') || initialPath.startsWith('/mock/ctf/');
      if (store.acquireLock && needsSession) releaseStoreLock = await store.acquireLock();
      const ctx = needsSession ? await sessionContext(req) : { sid: null, session: null, team: null, state: null };
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        if (!rateLimit(req, 'api', 240, 60_000) || !sessionRateLimit(ctx.sid, 'api', 180, 60_000)) return json(res, 429, { error: 'RATE_LIMITED', message: 'The terminal needs a moment. Try again shortly.' }, { 'Retry-After': '60' });
        if (req.method !== 'GET' && req.method !== 'HEAD' && !checkOrigin(req)) return json(res, 403, { error: 'ORIGIN_REJECTED', message: 'Cross-origin request rejected.' });
      }

      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, { status: 'ok', service: 'the-last-dataset-map-hub', mode: env.NODE_ENV || 'development', at: new Date().toISOString() });
      }
      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        if (!ctx.team) return json(res, 200, publicBootstrap());
        await store.write(ctx.state);
        return json(res, 200, getBootstrap(ctx.team, ctx.session, ctx.state));
      }
      if (pathname === '/api/register' && req.method === 'POST') {
        if (!rateLimit(req, 'registration', 8, 15 * 60_000)) return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many gate scans. Wait and retry.' }, { 'Retry-After': '900' });
        const body = await readBody(req);
        const rawId = typeof body.teamId === 'string' ? body.teamId.trim() : '';
        const teamId = canonicalTeamId(rawId);
        const teamName = sanitizeTeamName(typeof body.teamName === 'string' ? body.teamName : '');
        if (!validateTeamId(rawId, config.teams.teamIdPattern)) return json(res, 400, { error: 'INVALID_TEAM_ID', message: 'Team ID must be 3–32 letters, numbers, or dashes.' });
        if (!validateTeamName(teamName, config.teams.teamNamePattern)) return json(res, 400, { error: 'INVALID_TEAM_NAME', message: 'Team name must be 2–40 characters; use letters, numbers, spaces, and basic punctuation.' });
        if (config.teams.mode === 'whitelist' && !config.teams.allowedIds.map(canonicalTeamId).includes(teamId)) return json(res, 403, { error: 'NOT_WHITELISTED', message: 'This Team ID is not cleared for entry.' });
        const state = await store.read();
        let team = state.teams[teamId];
        if (team && team.name !== teamName) return json(res, 409, { error: 'TEAM_NAME_LOCKED', message: 'This Team ID is already bound to a different team name. The original name cannot be overwritten.' });
        if (!team) {
          team = { id: teamId, name: teamName, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
          appendEvent(team, 'TEAM REGISTERED · GATE ACCESS GRANTED');
          state.teams[teamId] = team;
        } else appendEvent(team, 'TEAM RECONNECTED · PROGRESS RESTORED');
        const sid = randomId();
        state.sessions[sid] = { teamId, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), view: { screen: 'map' } };
        await store.write(state); setSessionCookie(res, sid);
        return json(res, 200, getBootstrap(team, state.sessions[sid], state));
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        if (!ctx.state || !ctx.sid) { clearSessionCookie(res); return json(res, 200, { authenticated: false }); }
        delete ctx.state.sessions[ctx.sid]; await store.write(ctx.state); clearSessionCookie(res);
        return json(res, 200, { authenticated: false });
      }
      if (pathname === '/api/view' && req.method === 'POST') {
        if (!requireTeam(ctx, res)) return;
        const body = await readBody(req);
        const screen = body.screen;
        if (!['map', 'zone', 'ctf'].includes(screen)) return json(res, 400, { error: 'INVALID_VIEW' });
        if (screen === 'map') ctx.session.view = { screen: 'map' };
        if (screen === 'zone') {
          const zone = config.zones.find((item) => item.id === body.zoneId);
          if (!zone || !isAllowedZone(ctx.team, zone.id)) return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Quarantine remains sealed. Clear the previous zone first.' });
          ctx.session.view = { screen: 'zone', zoneId: zone.id };
        }
        if (screen === 'ctf') {
          const found = findCtf(body.ctfId);
          if (!found || !isAllowedZone(ctx.team, found.zone.id)) return json(res, 403, { error: 'CTF_QUARANTINED', message: 'The challenge signal is sealed by quarantine.' });
          ctx.session.view = { screen: 'ctf', zoneId: found.zone.id, ctfId: found.ctf.id };
        }
        await store.write(ctx.state); return json(res, 200, { view: ctx.session.view });
      }
      if (pathname.startsWith('/api/zones/') && req.method === 'GET') {
        if (!requireTeam(ctx, res)) return;
        const zoneId = pathname.slice('/api/zones/'.length);
        const zone = config.zones.find((item) => item.id === zoneId);
        if (!zone) return json(res, 404, { error: 'ZONE_NOT_FOUND' });
        if (!isAllowedZone(ctx.team, zoneId)) return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'LOCKED: CLEAR THE PREVIOUS ZONE TO BREAK THE QUARANTINE.' });
        return json(res, 200, { zone: zoneState(ctx.team, zone), ctfs: zone.ctfs.map((ctf) => ({ id: ctf.id, title: ctf.title, briefing: ctf.briefing, solved: ctx.team.solvedCtfs.includes(ctf.id) })) });
      }
      if (pathname.startsWith('/api/ctfs/') && pathname.endsWith('/open') && req.method === 'POST') {
        if (!requireTeam(ctx, res)) return;
        const ctfId = pathname.slice('/api/ctfs/'.length, -'/open'.length);
        const found = findCtf(ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });
        if (!isAllowedZone(ctx.team, found.zone.id)) return json(res, 403, { error: 'CTF_QUARANTINED', message: 'This signal is behind an unbroken quarantine barrier.' });
        const body = await readBody(req).catch((err) => { if (err.status === 415) return {}; throw err; });
        ctx.session.view = { screen: 'ctf', zoneId: found.zone.id, ctfId: found.ctf.id };
        await store.write(ctx.state);
        return json(res, 200, { ctf: { id: found.ctf.id, title: found.ctf.title, briefing: found.ctf.briefing, solved: ctx.team.solvedCtfs.includes(found.ctf.id) }, zone: { id: found.zone.id, name: found.zone.name, color: found.zone.color }, url: found.ctf.url });
      }
      if (pathname === '/api/internal/complete' && req.method === 'POST') {
        if (!rateLimit(req, 'internal-complete', 120, 60_000)) return json(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': '60' });
        const body = await readBody(req);
        if (!body || typeof body.teamId !== 'string' || typeof body.ctfId !== 'string' || typeof body.signature !== 'string') return json(res, 400, { error: 'INVALID_COMPLETION' });
        const teamId = canonicalTeamId(body.teamId);
        const found = findCtf(body.ctfId);
        if (!found || !Number.isSafeInteger(Number(body.timestamp))) return json(res, 400, { error: 'INVALID_COMPLETION' });
        const secret = env[found.ctf.completion.secretEnv];
        if (!secret || secret.length < 32) return json(res, 503, { error: 'COMPLETION_NOT_CONFIGURED', message: 'The hub operator has not configured a 32+ character CTF shared secret.' });
        if (!validCtfSignature({ secret, teamId, ctfId: found.ctf.id, timestamp: body.timestamp, signature: body.signature })) return json(res, 401, { error: 'INVALID_SIGNATURE_OR_TIMESTAMP' });
        const replayKey = `${found.ctf.id}:${teamId}:${body.timestamp}:${body.signature}`;
        const state = await store.read();
        if (state.usedSignatures.includes(replayKey)) return json(res, 409, { error: 'REPLAY_REJECTED' });
        const team = state.teams[teamId];
        if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
        if (!isAllowedZone(team, found.zone.id)) return json(res, 403, { error: 'ZONE_QUARANTINED' });
        state.usedSignatures.push(replayKey);
        if (state.usedSignatures.length > 10000) state.usedSignatures = state.usedSignatures.slice(-8000);
        const changed = completeCtf(state, team, found.ctf, 'SERVER ATTESTED · DATA RECOVERED');
        await store.write(state);
        return json(res, 200, { ok: true, newlySolved: changed, solved: team.solvedCtfs.includes(found.ctf.id), ctfId: found.ctf.id });
      }
      if (devToolsEnabled && pathname === '/api/dev/solve' && req.method === 'POST') {
        if (!requireTeam(ctx, res)) return;
        const body = await readBody(req);
        const found = findCtf(body.ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });
        if (!isAllowedZone(ctx.team, found.zone.id)) return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Dev simulation respects the same progression rules.' });
        const changed = completeCtf(ctx.state, ctx.team, found.ctf, 'DEV SIMULATION · DATA RECOVERED');
        await store.write(ctx.state);
        return json(res, 200, { ok: true, newlySolved: changed, bootstrap: getBootstrap(ctx.team, ctx.session, ctx.state) });
      }
      if (pathname.startsWith('/mock/ctf/') && req.method === 'GET') {
        if (!ctx.team) { res.writeHead(302, { Location: '/#registration' }); return res.end(); }
        const ctfId = pathname.slice('/mock/ctf/'.length);
        const found = findCtf(ctfId);
        if (!found || !isAllowedZone(ctx.team, found.zone.id)) return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'SIGNAL LOST · QUARANTINE SEALED' });
        const configuredLocal = found.ctf.url === `/mock/ctf/${found.ctf.id}`;
        if (!configuredLocal) return json(res, 404, { error: 'NOT_A_PLACEHOLDER' });
        const alreadySolved = ctx.team.solvedCtfs.includes(found.ctf.id);
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
        const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terminal // ${htmlEscape(found.ctf.id)}</title><link rel="stylesheet" href="/styles.css"></head><body class="mock-body" data-ctf-id="${htmlEscape(found.ctf.id)}" data-dev-enabled="${devToolsEnabled ? 'true' : 'false'}"><main class="mock-terminal"><div class="mock-eyebrow">SANCTUARY / FIELD TERMINAL · ${htmlEscape(found.zone.name)}</div><div class="mock-stamp">${alreadySolved ? 'RECORD RECOVERED' : 'SIGNAL ACQUIRED'}</div><h1>${htmlEscape(found.ctf.title)}</h1><p>${htmlEscape(found.ctf.briefing)}</p><p class="mock-note">This is a placeholder CTF frame. Replace its URL in <code>config/zones.json</code> to connect the real application.</p><div id="mock-status" class="mock-status">${alreadySolved ? 'THIS DATASET IS ALREADY RECOVERED.' : devToolsEnabled ? 'DEVELOPMENT SIMULATION IS ACTIVE.' : 'AWAITING EXTERNAL CTF COMPLETION REPORT.'}</div>${devToolsEnabled && !alreadySolved ? '<button id="mock-solve" class="action-button">SIMULATE DATA RECOVERY</button>' : ''}<button id="mock-back" class="text-button">← BACK TO THE MAP</button></main><script src="/mock-ctf.js" defer></script></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(page) }); res.end(page); return;
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed'); }
      let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(staticRoot)) { res.writeHead(403); return res.end('Forbidden'); }
      let actualPath = filePath;
      if (!fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) actualPath = path.join(publicDir, 'index.html');
      if (!fs.existsSync(actualPath)) { res.writeHead(404); return res.end('Not found'); }
      const stat = fs.statSync(actualPath);
      const ext = path.extname(actualPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(actualPath).pipe(res);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || 500;
      if (status >= 500) console.error('[hub]', error.message);
      return json(res, status, { error: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: status >= 500 ? 'The terminal encountered an internal fault.' : error.message });
    } finally {
      if (releaseStoreLock) {
        try { await releaseStoreLock(); } catch (error) { console.error('[hub] failed to release progress lock:', error.message); }
      }
    }
  };
  const server = require('node:http').createServer(handler);
  server.handler = handler;
  server.hub = { config, store, isAllowedZone, zoneState, devToolsEnabled, sessionSecret, env, isProduction };
  return server;
}

module.exports = { createHubServer, htmlEscape };
