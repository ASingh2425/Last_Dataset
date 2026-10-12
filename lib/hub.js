const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { loadConfig } = require('./config');
const { createStore, createUpstashStore } = require('./store');
const { supabaseStore } = require('./supabaseStore');
const { evaluateSubmission } = require('./evaluator');
const {
  hmac, safeEqual, signSession, verifySessionCookie, randomId,
  validateTeamId, validateTeamName, canonicalTeamId, sanitizeTeamName, validCtfSignature
} = require('./security');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};
const MAX_BODY = 10 * 1024 * 1024; // 10MB to accommodate ML submission uploads

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function createHubServer(options = {}) {
  const baseDir = options.baseDir || path.resolve(__dirname, '..');
  const publicDir = path.join(baseDir, 'public');
  const serverDataDir = path.join(baseDir, 'server_data');
  const config = loadConfig(baseDir);
  const env = { ...process.env, ...(options.env || {}) };
  const envFile = path.join(baseDir, '.env');

  if (!options.env && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  const isProduction = env.NODE_ENV === 'production';
  const devToolsEnabled = !isProduction && env.ENABLE_DEV_TOOLS === 'true';
  const supabaseUrl = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_URL || '') : (env.SUPABASE_URL || 'https://bqedvdohyaeivdqzapyy.supabase.co');
  const supabaseKey = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_SERVICE_ROLE_KEY || '') : (env.SUPABASE_SERVICE_ROLE_KEY || 'sb_secret_XfkPDGFarJIm1rHUloL8bw_yMMXRTqU');
  const hasSupabase = env.DISABLE_SUPABASE !== 'true' && !!(supabaseUrl && supabaseKey);
  const sessionSecret = (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32)
    ? env.SESSION_SECRET
    : 'the-last-dataset-2026-production-super-secret-key-32chars';

  // Fallback file/redis store for offline testing
  const fallbackStore = options.store || (env.VERCEL ? createUpstashStore(env) : createStore(options.dataFile || env.DATA_FILE || path.join(baseDir, 'data', 'progress.json')));
  const rates = new Map();
  const staticRoot = path.resolve(publicDir) + path.sep;

  function publicBootstrap() {
    return {
      authenticated: false,
      progress: {
        solved: 0,
        total: 4,
        ratio: 0,
        complete: false
      },
      zones: config.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved: 0,
        state: zone.order === 1 ? 'available' : 'locked',
        unlocked: zone.order === 1
      })),
      event: config.event,
      devToolsEnabled,
      hasSupabase,
      serverTime: new Date().toISOString()
    };
  }

  function buildFallbackBootstrap(team) {
    const solvedSet = new Set(team?.solvedCtfs || []);
    const completedZonesSet = new Set(team?.completedZones || []);
    const unlockedZonesSet = new Set(team?.unlockedZones || []);
    const earnedDatasets = team?.datasets || [];

    const zones = config.zones.map((zone, idx) => {
      const solved = zone.ctfs.filter((c) => solvedSet.has(c.id)).length;
      const prevCleared = idx === 0 || completedZonesSet.has(config.zones[idx - 1].id) || config.zones[idx - 1].ctfs.every((c) => solvedSet.has(c.id));
      const isCleared = completedZonesSet.has(zone.id) || (zone.ctfs.length > 0 && solved === zone.ctfs.length);
      const isUnlocked = isCleared || unlockedZonesSet.has(zone.id) || prevCleared;
      const state = isCleared ? 'cleared' : isUnlocked ? (solved > 0 ? 'in-progress' : 'available') : 'locked';
      return {
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved,
        solvedCtfs: zone.ctfs.filter((c) => solvedSet.has(c.id)).map((c) => c.id),
        unlocked: isUnlocked,
        state,
        ctfs: isUnlocked ? zone.ctfs.map((c) => ({ id: c.id, title: c.title, briefing: c.briefing, solved: solvedSet.has(c.id) })) : []
      };
    });
    const totalCtfs = config.zones.reduce((s, z) => s + z.ctfs.length, 0);
    const totalFragments = 4;
    const recoveredFragments = earnedDatasets.length;

    return {
      authenticated: true,
      teamId: team?.id,
      team: {
        id: team?.id,
        name: team?.name || team?.id,
        createdAt: team?.createdAt,
        solvedCtfs: team?.solvedCtfs || []
      },
      player: {
        delegateId: team?.delegateId || 'LEADER'
      },
      score: {
        total: team?.score || (solvedSet.size * 20)
      },
      sanctuaryCompleted: team?.sanctuaryCompleted ?? true,
      datasets: earnedDatasets,
      ml: {
        bestR2: team?.bestR2 || null,
        escapeUnlocked: !!team?.escapeUnlocked
      },
      zones,
      progress: {
        solved: recoveredFragments > 0 ? recoveredFragments : solvedSet.size,
        total: recoveredFragments > 0 ? totalFragments : totalCtfs,
        ratio: (recoveredFragments > 0 ? recoveredFragments / totalFragments : (totalCtfs ? solvedSet.size / totalCtfs : 0)),
        complete: (recoveredFragments >= totalFragments) || (totalCtfs > 0 && solvedSet.size >= totalCtfs)
      },
      events: team?.events || [],
      event: config.event,
      serverTime: new Date().toISOString()
    };
  }

  function setSessionCookie(res, sessionId) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=${signSession(sessionId, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`);
  }

  function clearSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  }

  async function sessionContext(req) {
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const index = part.indexOf('=');
          return index < 0 ? ['', ''] : [part.slice(0, index), part.slice(index + 1)];
        })
        .filter(([name]) => name)
    );

    let sid = verifySessionCookie(cookies.td_session, sessionSecret);
    if (!sid) {
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        sid = verifySessionCookie(token, sessionSecret) || (token.length >= 32 ? token : null);
      } else if (req.headers['x-session-id']) {
        const token = String(req.headers['x-session-id']).trim();
        sid = verifySessionCookie(token, sessionSecret) || (token.length >= 32 ? token : null);
      }
    }

    const headerTeamId = req.headers['x-team-id'] ? String(req.headers['x-team-id']).trim().toUpperCase() : null;
    const headerDelegateId = req.headers['x-delegate-id'] ? String(req.headers['x-delegate-id']).trim() : null;

    if (hasSupabase) {
      if (sid) {
        const active = await supabaseStore.validateSession(sid);
        if (active) {
          return {
            sid,
            session: active,
            team: active.team,
            teamId: active.teamId,
            delegateId: active.delegateId,
            isSupabase: true
          };
        }
      }
      if (headerTeamId) {
        const team = await supabaseStore.getTeamDirect(headerTeamId);
        if (team) {
          return {
            sid: null,
            session: null,
            team,
            teamId: team.id,
            delegateId: headerDelegateId || 'OPERATOR',
            isSupabase: true
          };
        }
      }
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    } else {
      const state = await fallbackStore.read();
      if (sid && state.sessions[sid] && state.teams[state.sessions[sid].teamId]) {
        const session = state.sessions[sid];
        session.lastSeen = new Date().toISOString();
        return {
          sid,
          session,
          team: state.teams[session.teamId],
          teamId: session.teamId,
          delegateId: session.delegateId || 'LEADER',
          state,
          isSupabase: false
        };
      }
      if (headerTeamId && state.teams[headerTeamId]) {
        return {
          sid: null,
          session: null,
          team: state.teams[headerTeamId],
          teamId: headerTeamId,
          delegateId: headerDelegateId || 'LEADER',
          state,
          isSupabase: false
        };
      }
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    }
  }

  function rateLimit(req, key, max, windowMs) {
    const now = Date.now();
    const rawIp = (req.socket?.remoteAddress || req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'] || 'unknown');
    const ip = String(rawIp).split(',')[0].trim().replace(/^::ffff:/, '');
    const id = `${ip}|${key}`;
    let item = rates.get(id);
    if (!item || now - item.start > windowMs) item = { start: now, count: 0 };
    item.count += 1;
    rates.set(id, item);
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
    try {
      const parsed = new URL(origin);
      if (parsed.host === req.headers.host) return true;
      if (parsed.hostname.endsWith('.vercel.app')) return true;
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
      return false;
    } catch { return false; }
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    const raw = Buffer.concat(chunks).toString('utf8');
    if (type === 'application/json') {
      try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Malformed JSON'), { status: 400 }); }
    }
    return { raw };
  }

  function commonHeaders(res, req) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");

    const origin = req?.headers?.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id, x-team-id, x-delegate-id, Accept');
    }
  }

  async function executeZoneCompletion(targetTeamId, zoneId, delegateId = 'OPERATOR') {
    const cleanTeamId = String(targetTeamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('Team ID required');

    const zoneNextMap = { sanctuary: 'yellow', yellow: 'blue', blue: 'orange', orange: 'red', red: 'purple', purple: null };
    const zoneRewardMap = { sanctuary: null, yellow: 'community_final', blue: 'radio_final', orange: 'forensics_final', red: 'research_final', purple: null };
    const zonePointsMap = { sanctuary: 10, yellow: 100, blue: 400, orange: 20, red: 20, purple: 500 };

    let bootstrap;
    if (hasSupabase) {
      await supabaseStore.completeZoneDirect({
        teamId: cleanTeamId,
        delegateId,
        zoneId
      });
      bootstrap = await supabaseStore.getTeamBootstrap(cleanTeamId, delegateId, config);
    } else {
      const state = await fallbackStore.read();
      let team = state.teams[cleanTeamId];
      if (!team) {
        team = { id: cleanTeamId, name: cleanTeamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
        state.teams[cleanTeamId] = team;
      }
      team.completedZones = Array.from(new Set([...(team.completedZones || []), zoneId]));
      if (zoneId === 'sanctuary') {
        team.sanctuaryCompleted = true;
      }
      const nextZone = zoneNextMap[zoneId];
      if (nextZone) {
        team.unlockedZones = Array.from(new Set([...(team.unlockedZones || []), nextZone]));
      }
      const reward = zoneRewardMap[zoneId];
      if (reward) {
        team.datasets = Array.from(new Set([...(team.datasets || []), reward]));
      }
      team.score = (team.score || 0) + (zonePointsMap[zoneId] || 0);
      team.events = team.events || [];
      team.events.unshift({
        at: new Date().toISOString(),
        message: `Sector ${zoneId.toUpperCase()} completed. Next sector: ${nextZone ? nextZone.toUpperCase() : 'ESCAPE'}`
      });
      await fallbackStore.write(state);
      bootstrap = buildFallbackBootstrap(team);
    }
    return bootstrap;
  }

  function findCtf(ctfId) {
    for (const zone of config.zones) {
      const ctf = zone.ctfs.find((item) => item.id === ctfId);
      if (ctf) return { zone, ctf };
    }
    return null;
  }

  function isAllowedZone(team, zoneId) {
    const idx = config.zones.findIndex((z) => z.id === zoneId);
    if (idx <= 0) return true;
    const prev = config.zones[idx - 1];
    return prev.ctfs.every((c) => (team?.solvedCtfs || []).includes(c.id));
  }

  const handler = async (req, res) => {
    commonHeaders(res, req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const initialPath = decodeURIComponent(url.pathname);
      const isApi = initialPath.startsWith('/api/');

      const ctx = isApi ? await sessionContext(req) : { sid: null, session: null, team: null, teamId: null, delegateId: null };
      const pathname = initialPath;

      if (isApi) {
        if (!rateLimit(req, 'api', 240, 60_000) || !sessionRateLimit(ctx.sid, 'api', 180, 60_000)) {
          return json(res, 429, { error: 'RATE_LIMITED', message: 'The terminal needs a moment. Try again shortly.' }, { 'Retry-After': '60' });
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !checkOrigin(req)) {
          return json(res, 403, { error: 'ORIGIN_REJECTED', message: 'Cross-origin request rejected.' });
        }
      }

      // -------------------------------------------------------------------
      // 1. SYSTEM HEALTH
      // -------------------------------------------------------------------
      if (pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          status: 'ok',
          service: 'the-last-dataset-central-hub',
          database: hasSupabase ? 'supabase-postgresql' : 'local-store',
          mode: env.NODE_ENV || 'development',
          at: new Date().toISOString()
        });
      }

      // -------------------------------------------------------------------
      // 2. BOOTSTRAP (Live Team & Progression State)
      // -------------------------------------------------------------------
      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const queryTeamId = (url.searchParams.get('teamId') || url.searchParams.get('team') || '').trim().toUpperCase();
        const effectiveTeamId = ctx.teamId || queryTeamId;
        if (!effectiveTeamId) return json(res, 200, publicBootstrap());
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[effectiveTeamId] || ctx.team;
          if (!team) return json(res, 200, publicBootstrap());
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 2.1 TEAM PROGRESS QUERY (Cross-Zone Client Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/team/progress' && req.method === 'GET') {
        const queryTeamId = (url.searchParams.get('teamId') || url.searchParams.get('team') || '').trim().toUpperCase();
        const effectiveTeamId = ctx.teamId || queryTeamId;
        if (!effectiveTeamId) return json(res, 400, { error: 'TEAM_ID_REQUIRED' });
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(effectiveTeamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[effectiveTeamId] || ctx.team;
          if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 3. REGISTRATION & LOGIN (Team ID + Delegate ID + Passcode)
      // -------------------------------------------------------------------
      if ((pathname === '/api/register' || pathname === '/api/login') && req.method === 'POST') {
        if (!rateLimit(req, 'login', 20, 15 * 60_000)) {
          return json(res, 429, { error: 'RATE_LIMITED', message: 'Too many authentication attempts. Please wait.' }, { 'Retry-After': '300' });
        }

        const body = await readBody(req);
        const teamId = String(body.teamId || '').trim();
        const delegateId = String(body.delegateId || '').trim();
        const passcode = String(body.passcode || body.teamPasscode || body.password || '').trim();

        if (hasSupabase) {
          const authResult = await supabaseStore.authenticatePlayer({ teamId, delegateId, passcode });
          if (!authResult.success) {
            return json(res, 401, { error: 'AUTH_FAILED', message: authResult.error });
          }

          setSessionCookie(res, authResult.sessionId);
          const bootstrap = await supabaseStore.getTeamBootstrap(authResult.team.id, authResult.member.delegate_id, config);
          bootstrap.sessionId = authResult.sessionId;
          return json(res, 200, bootstrap);
        } else {
          // Fallback legacy development registration
          const rawId = canonicalTeamId(teamId);
          if (!validateTeamId(rawId, config.teams?.teamIdPattern)) {
            return json(res, 400, { error: 'INVALID_ID' });
          }
          if (body.teamName && !validateTeamName(body.teamName, config.teams?.teamNamePattern)) {
            return json(res, 400, { error: 'INVALID_NAME' });
          }
          if (config.teams?.mode === 'whitelist' && !config.teams.allowedIds?.includes(rawId)) {
            return json(res, 403, { error: 'WHITELIST_REJECTED' });
          }
          const state = await fallbackStore.read();
          let team = state.teams[rawId];
          if (team) {
            if (body.teamName && body.teamName !== team.name) {
              return json(res, 409, { error: 'TEAM_NAME_LOCKED' });
            }
          } else {
            team = { id: rawId, name: body.teamName || rawId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[rawId] = team;
          }
          const sid = randomId();
          state.sessions[sid] = { teamId: rawId, createdAt: new Date().toISOString(), view: { screen: 'map' } };
          await fallbackStore.write(state);
          setSessionCookie(res, sid);
          const fb = buildFallbackBootstrap(team);
          fb.sessionId = sid;
          return json(res, 200, fb);
        }
      }

      // -------------------------------------------------------------------
      // 4. LOGOUT
      // -------------------------------------------------------------------
      if (pathname === '/api/logout' && req.method === 'POST') {
        if (hasSupabase && ctx.sid) {
          await supabaseStore.destroySession(ctx.sid);
        }
        clearSessionCookie(res);
        return json(res, 200, { authenticated: false });
      }

      // -------------------------------------------------------------------
      // 5. VIEW STATE
      // -------------------------------------------------------------------
      if (pathname === '/api/view' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const body = await readBody(req);
        return json(res, 200, { ok: true, view: body });
      }

      // -------------------------------------------------------------------
      // 6. ZONE DETAIL & CTF OPEN
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/zones/') && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const zoneId = pathname.slice('/api/zones/'.length);
        const zone = config.zones.find((item) => item.id === zoneId);
        if (!zone) return json(res, 404, { error: 'ZONE_NOT_FOUND' });
        if (!hasSupabase && !isAllowedZone(ctx.team, zone.id)) {
          return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Zone access locked.' });
        }

        return json(res, 200, {
          zone: { id: zone.id, name: zone.name, color: zone.color },
          ctfs: zone.ctfs.map((ctf) => ({ id: ctf.id, title: ctf.title, briefing: ctf.briefing }))
        });
      }

      if (pathname.startsWith('/api/ctfs/') && pathname.endsWith('/open') && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const ctfId = pathname.slice('/api/ctfs/'.length, -'/open'.length);
        const found = findCtf(ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });
        if (!hasSupabase && !isAllowedZone(ctx.team, found.zone.id)) {
          return json(res, 403, { error: 'ZONE_QUARANTINED', message: 'Zone access locked.' });
        }

        return json(res, 200, {
          ctf: { id: found.ctf.id, title: found.ctf.title, briefing: found.ctf.briefing },
          zone: { id: found.zone.id, name: found.zone.name, color: found.zone.color },
          url: found.ctf.url
        });
      }

      // -------------------------------------------------------------------
      // 7. SECURE DATASET DOWNLOAD (Entitlement-Checked)
      // -------------------------------------------------------------------
      // 7.1 SANCTUARY COMPLETION (Unlocks Yellow Zone after storyline)
      // -------------------------------------------------------------------
      if (pathname === '/api/sanctuary/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, 'sanctuary', ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.15 YELLOW COMPLETION (Unlocks Blue Zone & community_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/yellow/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, 'yellow', ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.16 BLUE COMPLETION (Unlocks Orange Zone & radio_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/blue/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, 'blue', ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.17 ORANGE COMPLETION (Unlocks Red Zone & forensics_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/orange/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, 'orange', ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.18 RED COMPLETION (Unlocks Purple Zone & research_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/red/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, 'red', ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.19 UNIFIED ZONE COMPLETION (Direct Cross-Zone Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/zone/complete' && req.method === 'POST') {
        const body = await readBody(req);
        const targetTeamId = (ctx.teamId || body.teamId || req.headers['x-team-id'] || '').trim().toUpperCase();
        if (!targetTeamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        const zoneId = String(body.zoneId || '').trim().toLowerCase();
        if (!['sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'].includes(zoneId)) {
          return json(res, 400, { error: 'INVALID_ZONE', message: `Unknown zone: ${zoneId}` });
        }

        try {
          const bootstrap = await executeZoneCompletion(targetTeamId, zoneId, ctx.delegateId || body.delegateId);
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          return json(res, 500, { error: 'COMPLETION_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.2 DATASET ENTITLEMENTS & DOWNLOAD (Strict Server-Side Gate)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/dataset/') && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to download datasets.' });
        const datasetKey = pathname.slice('/api/dataset/'.length).replace(/\.csv$/, '');

        const validDatasets = ['community_final', 'radio_final', 'forensics_final', 'research_final', 'train', 'sample_submission'];
        if (!validDatasets.includes(datasetKey)) {
          return json(res, 404, { error: 'DATASET_NOT_FOUND' });
        }

        // sample_submission is open to all authenticated survivors as an evaluation benchmark
        if (datasetKey === 'sample_submission') {
          // Open to authenticated users
        } else if (datasetKey === 'train') {
          // train.csv is given ONLY in Purple Zone
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
          const purpleZone = bootstrap.zones.find((z) => z.id === 'purple');
          if (!purpleZone || !purpleZone.unlocked) {
            return json(res, 403, {
              error: 'ENTITLEMENT_LOCKED',
              message: 'train.csv is locked until your team reaches the Purple Zone.'
            });
          }
        } else {
          const hasAccess = await supabaseStore.checkDatasetEntitlement(ctx.teamId, datasetKey);
          if (!hasAccess) {
            return json(res, 403, {
              error: 'ENTITLEMENT_LOCKED',
              message: `Your team has not yet completed the required zone to earn ${datasetKey}.csv.`
            });
          }
        }

        const fileName = `${datasetKey}.csv`;
        const filePath = path.join(serverDataDir, fileName);
        if (!fs.existsSync(filePath)) {
          return json(res, 404, { error: 'FILE_UNAVAILABLE', message: 'Dataset file is currently being processed.' });
        }

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store'
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      // -------------------------------------------------------------------
      // 8. PURPLE ZONE ML EVALUATION (Strict Server-Side Evaluator)
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/evaluate' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });

        // Strict limit: Maximum 10 submissions allowed per team
        let existingSubs = [];
        if (hasSupabase) {
          try {
            existingSubs = await supabaseStore.getTeamSubmissions(ctx.teamId);
          } catch (_) {
            existingSubs = [];
          }
        } else {
          const state = await fallbackStore.read();
          existingSubs = state.teams[ctx.teamId]?.mlSubmissions || [];
        }

        if (existingSubs.length >= 10) {
          return json(res, 429, {
            error: 'SUBMISSION_LIMIT_EXCEEDED',
            message: 'Maximum 10 submissions allowed per team. Submission quota exhausted.',
            submissionsUsed: existingSubs.length,
            submissionsRemaining: 0,
            maxAllowed: 10
          });
        }

        if (!rateLimit(req, `ml-sub:${ctx.teamId}`, 10, 60 * 60_000)) {
          return json(res, 429, {
            error: 'SUBMISSION_LIMIT_EXCEEDED',
            message: 'Evaluation rate limit exceeded: Maximum 10 submissions allowed.',
            submissionsUsed: existingSubs.length,
            submissionsRemaining: Math.max(0, 10 - existingSubs.length),
            maxAllowed: 10
          });
        }

        const body = await readBody(req);
        const csvContent = body.csvContent || body.raw || '';
        const rawFilename = body.rawFilename || 'submission.csv';

        const evalResult = evaluateSubmission(csvContent);

        if (!evalResult.valid) {
          if (hasSupabase) {
            await supabaseStore.recordMlSubmission({
              teamId: ctx.teamId,
              delegateId: ctx.delegateId,
              r2Score: null,
              mseScore: null,
              qualifiesForEscape: false,
              status: 'rejected',
              errorMessage: evalResult.error,
              rawFilename
            });
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[ctx.teamId];
            if (team) {
              team.mlSubmissions = team.mlSubmissions || [];
              team.mlSubmissions.unshift({
                id: 'sub-' + Date.now(),
                team_id: ctx.teamId,
                delegate_id: ctx.delegateId,
                r2_score: null,
                mse_score: null,
                qualifies_for_escape: false,
                status: 'rejected',
                error_message: evalResult.error,
                raw_filename: rawFilename,
                submitted_at: new Date().toISOString()
              });
              await fallbackStore.write(state);
            }
          }
          return json(res, 400, {
            error: 'VALIDATION_FAILED',
            message: evalResult.error,
            submissionsUsed: existingSubs.length + 1,
            submissionsRemaining: Math.max(0, 10 - (existingSubs.length + 1)),
            maxAllowed: 10
          });
        }

        // Record successful evaluation
        if (hasSupabase) {
          await supabaseStore.recordMlSubmission({
            teamId: ctx.teamId,
            delegateId: ctx.delegateId,
            r2Score: evalResult.r2Score,
            mseScore: evalResult.mseScore,
            qualifiesForEscape: evalResult.qualifiesForEscape,
            status: 'valid',
            errorMessage: null,
            rawFilename
          });
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[ctx.teamId];
          if (team) {
            team.mlSubmissions = team.mlSubmissions || [];
            team.mlSubmissions.unshift({
              id: 'sub-' + Date.now(),
              team_id: ctx.teamId,
              delegate_id: ctx.delegateId,
              r2_score: evalResult.r2Score,
              mse_score: evalResult.mseScore,
              qualifies_for_escape: evalResult.qualifiesForEscape,
              status: 'valid',
              error_message: null,
              raw_filename: rawFilename,
              submitted_at: new Date().toISOString()
            });
            await fallbackStore.write(state);
          }
        }

        // If qualified for escape (R2 >= 0.80), complete purple challenge automatically
        if (evalResult.qualifiesForEscape) {
          if (hasSupabase) {
            try {
              await supabaseStore.completeChallenge({
                teamId: ctx.teamId,
                delegateId: ctx.delegateId,
                zoneId: 'purple',
                challengeId: 'purple-01',
                points: 500,
                allZoneChallenges: ['purple-01'],
                nextZoneId: null,
                rewardDatasetKey: null
              });
            } catch (e) {
              console.error('[purple escape solve]', e.message);
            }
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[ctx.teamId];
            if (team && !team.solvedCtfs.includes('purple-01')) {
              team.solvedCtfs.push('purple-01');
              await fallbackStore.write(state);
            }
          }
        }

        const submissionsUsed = existingSubs.length + 1;
        const submissionsRemaining = Math.max(0, 10 - submissionsUsed);

        return json(res, 200, {
          success: true,
          r2Score: evalResult.r2Score,
          mseScore: evalResult.mseScore,
          qualifiesForEscape: evalResult.qualifiesForEscape,
          threshold: evalResult.threshold,
          message: evalResult.message,
          submissionsUsed,
          submissionsRemaining,
          maxAllowed: 10
        });
      }

      // -------------------------------------------------------------------
      // 8.1 PURPLE ZONE SUBMISSION HISTORY
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/submissions' && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        try {
          let submissions = [];
          if (hasSupabase) {
            submissions = await supabaseStore.getTeamSubmissions(ctx.teamId);
          } else {
            const state = await fallbackStore.read();
            submissions = state.teams[ctx.teamId]?.mlSubmissions || [];
          }
          const submissionsUsed = submissions.length;
          const submissionsRemaining = Math.max(0, 10 - submissionsUsed);
          return json(res, 200, {
            submissions,
            submissionsUsed,
            submissionsRemaining,
            maxAllowed: 10,
            at: new Date().toISOString()
          });
        } catch (err) {
          return json(res, 500, { error: 'FETCH_FAILED', message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 9. LIVE LEADERBOARD
      // -------------------------------------------------------------------
      if (pathname === '/api/leaderboard' && req.method === 'GET') {
        const board = await supabaseStore.getLeaderboard();
        return json(res, 200, { leaderboard: board, at: new Date().toISOString() });
      }

      // -------------------------------------------------------------------
      // 10. ATOMIC SERVER-TO-SERVER CHALLENGE COMPLETION (HMAC)
      // -------------------------------------------------------------------
      if (pathname === '/api/internal/complete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body.teamId !== 'string' || typeof body.ctfId !== 'string' || typeof body.signature !== 'string') {
          return json(res, 400, { error: 'INVALID_COMPLETION' });
        }
        const teamId = canonicalTeamId(body.teamId);
        const found = findCtf(body.ctfId);
        if (!found || !Number.isSafeInteger(Number(body.timestamp))) return json(res, 400, { error: 'INVALID_COMPLETION' });

        const secret = env[found.ctf.completion.secretEnv];
        if (!secret) return json(res, 503, { error: 'SECRET_NOT_CONFIGURED' });

        if (!validCtfSignature({ secret, teamId, ctfId: found.ctf.id, timestamp: body.timestamp, signature: body.signature })) {
          return json(res, 401, { error: 'INVALID_SIGNATURE' });
        }

        // Zone completion reward mappings
        const zoneNextMap = { yellow: 'blue', blue: 'orange', orange: 'red', red: 'purple' };
        const zoneRewardMap = { yellow: 'community_final', blue: 'radio_final', orange: 'forensics_final', red: 'research_final' };
        const allZoneIds = found.zone.ctfs.map((c) => c.id);

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId,
            delegateId: body.delegateId || null,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: 20,
            allZoneChallenges: allZoneIds,
            nextZoneId: zoneNextMap[found.zone.id] || null,
            rewardDatasetKey: zoneRewardMap[found.zone.id] || null
          });
          return json(res, 200, { ok: true, ...rpcResult });
        } else {
          const state = await fallbackStore.read();
          state.usedSignatures = state.usedSignatures || [];
          if (state.usedSignatures.includes(body.signature)) {
            return json(res, 409, { error: 'REPLAY_REJECTED' });
          }
          state.usedSignatures.push(body.signature);
          let team = state.teams[teamId];
          if (!team) {
            team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[teamId] = team;
          }
          team.solvedCtfs = team.solvedCtfs || [];
          const newlySolved = !team.solvedCtfs.includes(found.ctf.id);
          if (newlySolved) team.solvedCtfs.push(found.ctf.id);
          await fallbackStore.write(state);
          return json(res, 200, { ok: true, newlySolved });
        }
      }

      // -------------------------------------------------------------------
      // 11. DEV SIMULATION SOLVE
      // -------------------------------------------------------------------
      if (devToolsEnabled && pathname === '/api/dev/solve' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED' });
        const body = await readBody(req);
        const found = findCtf(body.ctfId);
        if (!found) return json(res, 404, { error: 'CTF_NOT_FOUND' });

        const zoneNextMap = { yellow: 'blue', blue: 'orange', orange: 'red', red: 'purple' };
        const zoneRewardMap = { yellow: 'community_final', blue: 'radio_final', orange: 'forensics_final', red: 'research_final' };
        const allZoneIds = found.zone.ctfs.map((c) => c.id);

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId: ctx.teamId,
            delegateId: ctx.delegateId,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: 20,
            allZoneChallenges: allZoneIds,
            nextZoneId: zoneNextMap[found.zone.id] || null,
            rewardDatasetKey: zoneRewardMap[found.zone.id] || null
          });

          const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
          return json(res, 200, { ok: true, rpcResult, bootstrap: nextBootstrap });
        } else {
          const state = await fallbackStore.read();
          let team = state.teams[ctx.teamId];
          if (!team) {
            team = { id: ctx.teamId, name: ctx.teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[ctx.teamId] = team;
          }
          team.solvedCtfs = team.solvedCtfs || [];
          const newlySolved = !team.solvedCtfs.includes(found.ctf.id);
          if (newlySolved) team.solvedCtfs.push(found.ctf.id);
          await fallbackStore.write(state);
          const bootstrap = buildFallbackBootstrap(team);
          return json(res, 200, { ok: true, newlySolved, bootstrap });
        }
      }

      // -------------------------------------------------------------------
      // 12. STATIC FILES & HTML (PRESERVED THREE.JS / SCENE FILES)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }

      let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(staticRoot)) { res.writeHead(403); return res.end('Forbidden'); }

      let actualPath = filePath;
      if (fs.existsSync(actualPath) && fs.statSync(actualPath).isDirectory()) {
        const indexCandidate = path.join(actualPath, 'index.html');
        if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
          actualPath = indexCandidate;
        }
      }

      if (!fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) {
        const rootPath = path.resolve(baseDir, relative);
        if (fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()) {
          actualPath = rootPath;
        } else {
          const staticMap = {
            'index.html': path.join(__dirname, '..', 'public', 'index.html'),
            'app.js': path.join(__dirname, '..', 'public', 'app.js'),
            'styles.css': path.join(__dirname, '..', 'public', 'styles.css'),
            'scene.js': path.join(__dirname, '..', 'public', 'scene.js'),
            'mock-ctf.js': path.join(__dirname, '..', 'public', 'mock-ctf.js')
          };
          actualPath = staticMap[relative] || staticMap['index.html'];
        }
      }
      if (!fs.existsSync(actualPath)) { res.writeHead(404); return res.end('Not found'); }

      const stat = fs.statSync(actualPath);
      const ext = path.extname(actualPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      if (req.method === 'HEAD') return res.end();
      res.end(fs.readFileSync(actualPath));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || 500;
      if (status >= 500) console.error('[hub]', error);
      return json(res, status, { error: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: error.message });
    }
  };

  const server = require('node:http').createServer(handler);
  server.handler = handler;
  server.hub = { config, isProduction, devToolsEnabled };
  return server;
}

module.exports = { createHubServer, htmlEscape };
