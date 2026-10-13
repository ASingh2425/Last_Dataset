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
const {
  CANONICAL_STAGE_SCORES,
  TOTAL_COMPETITION_POINTS,
  ZONE_REQUIRED_CHALLENGES,
  ZONE_PREREQUISITES,
  ZONE_NEXT_MAP,
  ZONE_REWARD_DATASETS
} = require('../config/scoring');
const {
  buildEnrichedTeamOverview,
  buildAdminMetrics,
  ALL_ZONE_IDS
} = require('./adminOverview');

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

  const isProduction = env.NODE_ENV === 'production' || !!env.VERCEL;
  const devToolsEnabled = !isProduction && env.ENABLE_DEV_TOOLS === 'true';
  const supabaseUrl = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_URL || '') : (env.SUPABASE_URL || '');
  const supabaseKey = (options.dataFile || env.DISABLE_SUPABASE === 'true') ? (options.env?.SUPABASE_SERVICE_ROLE_KEY || '') : (env.SUPABASE_SERVICE_ROLE_KEY || '');
  const hasSupabase = env.DISABLE_SUPABASE !== 'true' && !!(supabaseUrl && supabaseKey);

  if (isProduction && !options.dataFile && !options.store && env.DISABLE_SUPABASE !== 'true' && (!supabaseUrl || !supabaseKey)) {
    console.warn('[hub] WARNING: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured. Live database sync requires these in Vercel Project Settings.');
  }

  const sessionSecret = (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32)
    ? env.SESSION_SECRET
    : 'the-last-dataset-2026-production-super-secret-key-32chars';

  // Fallback file/redis store for offline testing
  let inMemoryFallback = null;
  function getFallbackStore() {
    if (options.store) return options.store;
    if (options.dataFile) return createStore(options.dataFile);
    if (hasSupabase) {
      if (!inMemoryFallback) {
        let memoryState = { teams: {}, sessions: {}, usedSignatures: [] };
        inMemoryFallback = {
          filePath: 'memory',
          read: async () => memoryState,
          write: async (state) => { memoryState = state; },
          acquireLock: async () => () => {},
          initialState: () => memoryState
        };
      }
      return inMemoryFallback;
    }
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      return createUpstashStore(env);
    }
    const storePath = env.VERCEL
      ? path.join(require('node:os').tmpdir(), 'progress.json')
      : (env.DATA_FILE || path.join(baseDir, 'data', 'progress.json'));
    return createStore(storePath);
  }
  const fallbackStore = getFallbackStore();
  const rates = new Map();
  const disableRateLimit = env.DISABLE_RATE_LIMIT === 'true';
  const apiRateLimitMax = parseInt(env.API_RATE_LIMIT_MAX || '6000', 10);
  const sessionRateLimitMax = parseInt(env.SESSION_RATE_LIMIT_MAX || '3000', 10);
  const loginRateLimitMax = parseInt(env.LOGIN_RATE_LIMIT_MAX || '2000', 10);
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
        escapeUnlocked: !!team?.escapeUnlocked || (team?.mlSubmissions || []).some((s) => s.qualifies_for_escape)
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

  function buildFallbackAdminOverview(state) {
    const teams = Object.values(state.teams || {}).map((t) => {
      const completedZones = t.completedZones || [];
      const solvedCtfs = t.solvedCtfs || [];
      const rawZones = {};

      for (const zoneId of ALL_ZONE_IDS) {
        const isCompleted = completedZones.includes(zoneId);
        const prereq = ZONE_PREREQUISITES[zoneId];
        const isAvailable = zoneId === 'sanctuary' || (prereq && completedZones.includes(prereq));
        const zoneConfig = config.zones.find((z) => z.id === zoneId);
        const zoneCtfIds = zoneConfig ? zoneConfig.ctfs.map((c) => c.id) : [];
        const solvedInZone = solvedCtfs.filter((c) => zoneCtfIds.includes(c));

        rawZones[zoneId] = {
          status: isCompleted ? 'completed' : (isAvailable ? 'available' : 'locked'),
          solvedChallenges: solvedInZone,
          completedAt: isCompleted ? (t.events?.find((e) => e.zoneId === zoneId || e.type === `zone_${zoneId}`)?.timestamp || t.createdAt || null) : null
        };
      }

      const rawScores = (t.events || [])
        .filter((e) => e.points)
        .map((e, idx) => ({
          id: idx + 1,
          delegateId: e.delegateId || 'LEADER',
          points: e.points,
          sourceType: e.type || e.source || 'zone_clear',
          sourceId: e.zoneId || e.sourceId || null,
          idempotencyKey: `${t.id}:${e.zoneId || idx}`,
          createdAt: e.timestamp || t.createdAt
        }));

      return buildEnrichedTeamOverview({
        team: t,
        members: t.members || [],
        rawZones,
        rawSubmissions: t.mlSubmissions || [],
        rawScores
      });
    });

    const totalMlSubmissions = Object.values(state.teams || {}).reduce((acc, t) => acc + (t.mlSubmissions || []).length, 0);
    const metrics = buildAdminMetrics(teams, totalMlSubmissions);

    return {
      ...metrics,
      teams
    };
  }

  function getExpectedAdminKey() {
    return env.ADMIN_KEY || env.ADMIN_SECRET || 'tld-admin-master-key-2026';
  }

  function getAdminSessionId() {
    const expectedKey = getExpectedAdminKey();
    return expectedKey ? crypto.createHash('sha256').update('admin_session:' + expectedKey).digest('hex') : null;
  }

  function setAdminSessionCookie(res) {
    const sid = getAdminSessionId();
    if (!sid) return;
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_admin_session=${signSession(sid, sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
  }

  function clearAdminSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
  }

  function isAuthorizedAdmin(req, url) {
    const expectedKey = getExpectedAdminKey();
    if (!expectedKey) return false;

    // 1. Header check
    const adminKeyHeader = req.headers['x-admin-key'];
    if (adminKeyHeader && safeEqual(crypto.createHash('sha256').update(String(adminKeyHeader)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
      return true;
    }

    // 2. Query param check
    const adminKeyParam = url && url.searchParams ? url.searchParams.get('adminKey') : null;
    if (adminKeyParam && safeEqual(crypto.createHash('sha256').update(String(adminKeyParam)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
      return true;
    }

    // 3. Cookie check
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
    if (cookies.td_admin_session) {
      const adminVal = verifySessionCookie(cookies.td_admin_session, sessionSecret);
      const expectedSid = getAdminSessionId();
      if (adminVal && expectedSid && safeEqual(adminVal, expectedSid)) return true;
    }

    return false;
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

    if (!sid) {
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    }

    if (hasSupabase) {
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
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    } else {
      const state = await fallbackStore.read();
      if (state.sessions[sid] && state.teams[state.sessions[sid].teamId]) {
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
      return { sid: null, session: null, team: null, teamId: null, delegateId: null };
    }
  }

  function rateLimit(req, key, max, windowMs) {
    if (disableRateLimit) return true;
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

  const defaultAllowedOrigins = new Set([
    'https://yellowzone-xi.vercel.app',
    'https://yellow-zone.vercel.app',
    'https://yellowzone.vercel.app',
    'https://yellow-zone-asingh2425.vercel.app',
    'https://yellowzone-asingh2425.vercel.app',
    'https://bluezone-xi.vercel.app',
    'https://bluezone-three.vercel.app',
    'https://or-light-gamma.vercel.app',
    'https://red-five-liart.vercel.app',
    'https://intro-stroyline.vercel.app',
    'https://last-dataset-sanc.vercel.app',
    'https://yellow-to-blue-slideshow.vercel.app',
    'https://blue-orange-slideshow-ogib.vercel.app',
    'https://orange-to-red-slideshow.vercel.app',
    'https://red-purple-slideshow.vercel.app',
    'https://purplezone.vercel.app',
    'https://purplezone-frontend.vercel.app'
  ]);
  if (env.ALLOWED_ORIGINS) {
    for (const o of String(env.ALLOWED_ORIGINS).split(',')) {
      if (o.trim()) defaultAllowedOrigins.add(o.trim());
    }
  }

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      if (parsed.host === req.headers.host) return true;
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
      if (defaultAllowedOrigins.has(origin) || defaultAllowedOrigins.has(parsed.origin)) return true;
      if (parsed.hostname.endsWith('.vercel.app') && (parsed.hostname.includes('yellow') || parsed.hostname.includes('manu'))) return true;
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
    if (origin && checkOrigin(req)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id, x-team-id, Accept');
    }
  }

  async function reserveAttemptFallback(teamId, delegateId, rawFilename, maxAttempts = 10) {
    const release = fallbackStore.acquireLock ? await fallbackStore.acquireLock() : () => {};
    try {
      const state = await fallbackStore.read();
      let team = state.teams[teamId];
      if (!team) {
        team = { id: teamId, name: teamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], mlSubmissions: [] };
        state.teams[teamId] = team;
      }
      team.mlSubmissions = team.mlSubmissions || [];
      const count = team.mlSubmissions.length;

      // Check if team has already qualified or completed purple zone
      const alreadyCompleted =
        Boolean(team.escapeUnlocked) ||
        (team.completedZones || []).includes('purple') ||
        (team.mlSubmissions || []).some((s) => s.qualifies_for_escape || (s.r2_score !== null && s.r2_score >= 0.80));

      if (alreadyCompleted) {
        return {
          allowed: false,
          alreadyCompleted: true,
          reason: 'PURPLE_ALREADY_COMPLETED',
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0
        };
      }

      if (count >= maxAttempts) {
        return {
          allowed: false,
          alreadyCompleted: false,
          reason: 'SUBMISSION_LIMIT_EXCEEDED',
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0
        };
      }
      const subId = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const now = new Date().toISOString();
      team.mlSubmissions.unshift({
        id: subId,
        team_id: teamId,
        delegate_id: delegateId || 'OPERATOR',
        status: 'pending',
        raw_filename: rawFilename || 'submission.csv',
        submitted_at: now
      });
      await fallbackStore.write(state);
      return {
        allowed: true,
        alreadyCompleted: false,
        submissionId: subId,
        attemptNumber: count + 1,
        submissionsUsed: count + 1,
        submissionsRemaining: Math.max(0, maxAttempts - (count + 1)),
        submittedAt: now
      };
    } finally {
      release();
    }
  }

  async function finalizeAttemptFallback(teamId, submissionId, { r2Score, mseScore, qualifiesForEscape, status, errorMessage }) {
    const release = fallbackStore.acquireLock ? await fallbackStore.acquireLock() : () => {};
    try {
      const state = await fallbackStore.read();
      const team = state.teams[teamId];
      if (team && team.mlSubmissions) {
        const sub = team.mlSubmissions.find((s) => s.id === submissionId);
        if (sub) {
          sub.r2_score = r2Score;
          sub.mse_score = mseScore;
          sub.qualifies_for_escape = qualifiesForEscape;
          sub.status = status;
          sub.error_message = errorMessage || null;
        }
        if (typeof r2Score === 'number' && (team.bestR2 === null || team.bestR2 === undefined || r2Score > team.bestR2)) {
          team.bestR2 = r2Score;
        }
        if (qualifiesForEscape) {
          team.escapeUnlocked = true;
          if (!team.solvedCtfs.includes('purple-01')) {
            team.solvedCtfs.push('purple-01');
          }
          team.completedZones = team.completedZones || [];
          if (!team.completedZones.includes('purple')) {
            team.completedZones.push('purple');
            team.score = (team.score || 0) + (CANONICAL_STAGE_SCORES.purple?.points || 1000);
            team.events = team.events || [];
            team.events.unshift({
              at: new Date().toISOString(),
              message: 'Sector PURPLE completed. Helicopter evacuation authorized!'
            });
          }
        }
        await fallbackStore.write(state);
        return sub;
      }
    } finally {
      release();
    }
  }

  async function executeZoneCompletion(targetTeamId, zoneId, delegateId = 'OPERATOR') {
    const cleanTeamId = String(targetTeamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('Team ID required');

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
        team = { id: cleanTeamId, name: cleanTeamId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], completedZones: [] };
        state.teams[cleanTeamId] = team;
      }

      const reqPrev = ZONE_PREREQUISITES[zoneId];
      if (reqPrev && !(team.completedZones || []).includes(reqPrev)) {
        throw new Error(`PREREQUISITE_NOT_MET: Previous sector "${reqPrev}" must be completed before "${zoneId}" can be cleared.`);
      }

      if (zoneId === 'purple') {
        const hasQual = (team.mlSubmissions || []).some((s) => s.qualifies_for_escape || (s.r2_score !== null && s.r2_score >= 0.80));
        if (!hasQual) {
          throw new Error('PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.');
        }
      }

      const reqChallenges = ZONE_REQUIRED_CHALLENGES[zoneId] || [];
      const solvedSet = new Set(team.solvedCtfs || []);
      const missingChallenges = reqChallenges.filter((c) => !solvedSet.has(c));
      if (missingChallenges.length > 0) {
        throw new Error(`CHALLENGES_INCOMPLETE: Required challenges [${missingChallenges.join(', ')}] must be solved before sector "${zoneId}" can be cleared.`);
      }

      const alreadyCompleted = (team.completedZones || []).includes(zoneId);
      team.completedZones = Array.from(new Set([...(team.completedZones || []), zoneId]));
      if (zoneId === 'sanctuary') {
        team.sanctuaryCompleted = true;
      }
      const nextZone = ZONE_NEXT_MAP[zoneId];
      if (nextZone) {
        team.unlockedZones = Array.from(new Set([...(team.unlockedZones || []), nextZone]));
      }
      const reward = ZONE_REWARD_DATASETS[zoneId];
      if (reward) {
        team.datasets = Array.from(new Set([...(team.datasets || []), reward]));
      }
      if (!alreadyCompleted) {
        const stageInfo = CANONICAL_STAGE_SCORES[zoneId];
        team.score = (team.score || 0) + (stageInfo ? stageInfo.points : 0);
      }
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
        if (!rateLimit(req, 'api', apiRateLimitMax, 60_000) || !sessionRateLimit(ctx.sid, 'api', sessionRateLimitMax, 60_000)) {
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
        if (!ctx.teamId) return json(res, 200, publicBootstrap());
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[ctx.teamId] || ctx.team;
          if (!team) return json(res, 200, publicBootstrap());
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 2.1 TEAM PROGRESS QUERY (Cross-Zone Client Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/team/progress' && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to view team progress.' });
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId || 'OPERATOR', config);
          return json(res, 200, bootstrap);
        } else {
          const state = await fallbackStore.read();
          const team = state.teams[ctx.teamId] || ctx.team;
          if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
          return json(res, 200, buildFallbackBootstrap(team));
        }
      }

      // -------------------------------------------------------------------
      // 3. REGISTRATION & LOGIN (Team ID + Delegate ID + Passcode)
      // -------------------------------------------------------------------
      if ((pathname === '/api/register' || pathname === '/api/login') && req.method === 'POST') {
        if (!rateLimit(req, 'login', loginRateLimitMax, 15 * 60_000)) {
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
            team = { id: rawId, name: body.teamName || rawId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [], members: [] };
            state.teams[rawId] = team;
          }
          team.members = team.members || [];
          if (Array.isArray(body.members) && body.members.length > 2) {
            return json(res, 400, { error: 'TEAM_CAP_EXCEEDED', message: 'Maximum 2 players permitted per team.' });
          }
          if (delegateId) {
            const hasMember = team.members.includes(delegateId);
            if (!hasMember) {
              if (team.members.length >= 2) {
                return json(res, 400, { error: 'TEAM_CAP_EXCEEDED', message: 'Maximum 2 players permitted per team.' });
              }
              team.members.push(delegateId);
            }
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
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, 'sanctuary', ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.15 YELLOW COMPLETION (Unlocks Blue Zone & community_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/yellow/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, 'yellow', ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.16 BLUE COMPLETION (Unlocks Orange Zone & radio_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/blue/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, 'blue', ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.17 ORANGE COMPLETION (Unlocks Red Zone & forensics_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/orange/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, 'orange', ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.18 RED COMPLETION (Unlocks Purple Zone & research_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/red/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, 'red', ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
        }
      }

      // -------------------------------------------------------------------
      // 7.19 UNIFIED ZONE COMPLETION (Direct Cross-Zone Access)
      // -------------------------------------------------------------------
      if (pathname === '/api/zone/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        const body = await readBody(req);
        const zoneId = String(body.zoneId || '').trim().toLowerCase();
        if (!['sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'].includes(zoneId)) {
          return json(res, 400, { error: 'INVALID_ZONE', message: `Unknown zone: ${zoneId}` });
        }

        try {
          const bootstrap = await executeZoneCompletion(ctx.teamId, zoneId, ctx.delegateId || 'OPERATOR');
          return json(res, 200, { ok: true, bootstrap });
        } catch (err) {
          const is403 = err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'));
          const status = is403 ? 403 : 500;
          const errCode = err.message?.includes('CHALLENGES_INCOMPLETE') ? 'CHALLENGES_INCOMPLETE' : (is403 ? 'PREREQUISITE_NOT_MET' : 'COMPLETION_FAILED');
          return json(res, status, { error: errCode, message: err.message });
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
          let isPurpleUnlocked = false;
          if (hasSupabase) {
            const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
            const purpleZone = bootstrap?.zones?.find((z) => z.id === 'purple');
            isPurpleUnlocked = !!(purpleZone && purpleZone.unlocked);
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[ctx.teamId];
            isPurpleUnlocked = !!(team && (team.unlockedZones || []).includes('purple'));
          }
          if (!isPurpleUnlocked) {
            return json(res, 403, {
              error: 'ENTITLEMENT_LOCKED',
              message: 'train.csv is locked until your team reaches the Purple Zone.'
            });
          }
        } else {
          let hasAccess = false;
          if (hasSupabase) {
            hasAccess = await supabaseStore.checkDatasetEntitlement(ctx.teamId, datasetKey);
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[ctx.teamId];
            hasAccess = !!(team && (team.datasets || []).includes(datasetKey));
          }
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
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to evaluate a model.' });

        const body = await readBody(req);
        const csvContent = body.csvContent || body.raw || '';
        const rawFilename = String(body.rawFilename || 'submission.csv').slice(0, 100);

        // Pre-validate CSV before consuming any quota attempt
        const evalResult = evaluateSubmission(csvContent);
        if (!evalResult.valid) {
          if (evalResult.error && evalResult.error.startsWith('SCORING_ARBITER_UNAVAILABLE')) {
            return json(res, 503, {
              error: 'EVALUATION_SERVICE_UNAVAILABLE',
              message: 'Scoring arbiter is currently unavailable. No attempt consumed.'
            });
          }
          let existingCount = 0;
          try {
            if (hasSupabase) {
              const subs = await supabaseStore.getTeamSubmissions(ctx.teamId);
              existingCount = subs.length;
            } else {
              const state = await fallbackStore.read();
              existingCount = (state.teams[ctx.teamId]?.mlSubmissions || []).length;
            }
          } catch (_) {}

          return json(res, 400, {
            error: 'VALIDATION_FAILED',
            message: evalResult.error,
            submissionsUsed: existingCount,
            submissionsRemaining: Math.max(0, 10 - existingCount),
            maxAllowed: 10,
            note: 'Invalid submission format. No attempt was consumed.'
          });
        }

        // Atomically reserve attempt (serialized mutex prevents race conditions)
        let reservation;
        try {
          if (hasSupabase) {
            reservation = await supabaseStore.reserveMlAttempt({
              teamId: ctx.teamId,
              delegateId: ctx.delegateId,
              rawFilename,
              maxAttempts: 10
            });
          } else {
            reservation = await reserveAttemptFallback(ctx.teamId, ctx.delegateId, rawFilename, 10);
          }
        } catch (dbErr) {
          console.error('[ml reserve error]', dbErr);
          return json(res, 503, {
            error: 'DATABASE_ERROR',
            message: 'Could not record submission attempt due to database error. Please try again.'
          });
        }

        if (!reservation.allowed) {
          if (reservation.alreadyCompleted || reservation.reason === 'PURPLE_ALREADY_COMPLETED') {
            return json(res, 429, {
              error: 'PURPLE_ALREADY_COMPLETED',
              message: 'Your team has already successfully completed the Purple Zone and qualified for evacuation. Further submissions are locked.',
              submissionsUsed: reservation.submissionsUsed,
              submissionsRemaining: 0,
              maxAllowed: 10
            });
          }
          return json(res, 429, {
            error: 'SUBMISSION_LIMIT_EXCEEDED',
            message: 'Maximum 10 submissions allowed per team. Submission quota exhausted.',
            submissionsUsed: reservation.submissionsUsed,
            submissionsRemaining: 0,
            maxAllowed: 10
          });
        }

        // Finalize submission
        try {
          if (hasSupabase) {
            if (evalResult.qualifiesForEscape) {
              await supabaseStore.finalizeQualifyingMlSubmission({
                submissionId: reservation.submissionId,
                teamId: ctx.teamId,
                delegateId: ctx.delegateId,
                r2Score: evalResult.r2Score,
                mseScore: evalResult.mseScore,
                points: CANONICAL_STAGE_SCORES.purple?.points || 1000
              });
            } else {
              await supabaseStore.finalizeMlSubmission({
                submissionId: reservation.submissionId,
                r2Score: evalResult.r2Score,
                mseScore: evalResult.mseScore,
                qualifiesForEscape: false,
                status: 'valid'
              });
            }
          } else {
            await finalizeAttemptFallback(ctx.teamId, reservation.submissionId, {
              r2Score: evalResult.r2Score,
              mseScore: evalResult.mseScore,
              qualifiesForEscape: evalResult.qualifiesForEscape,
              status: 'valid'
            });
          }
        } catch (dbErr) {
          console.error('[ml finalize error]', dbErr);
          return json(res, 503, {
            error: 'FINALIZATION_FAILED',
            message: 'Model evaluated successfully but could not be durably recorded. Call /api/ml/reconcile with this evaluationId to retry finalization.',
            evaluationId: reservation.submissionId,
            attemptNumber: reservation.attemptNumber,
            retryable: true
          });
        }

        return json(res, 200, {
          success: true,
          evaluationId: reservation.submissionId,
          attemptNumber: reservation.attemptNumber,
          timestamp: reservation.submittedAt || new Date().toISOString(),
          r2Score: evalResult.r2Score,
          mseScore: evalResult.mseScore,
          qualifiesForEscape: evalResult.qualifiesForEscape,
          threshold: evalResult.threshold,
          message: evalResult.message,
          submissionsUsed: reservation.submissionsUsed,
          submissionsRemaining: reservation.submissionsRemaining,
          maxAllowed: 10
        });
      }

      // -------------------------------------------------------------------
      // 8.05 PURPLE ZONE ML RECONCILIATION
      // -------------------------------------------------------------------
      if (pathname === '/api/ml/reconcile' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to reconcile an evaluation.' });

        const body = await readBody(req);
        const evaluationId = body.evaluationId;
        const csvContent = body.csvContent || body.raw || '';
        if (!evaluationId) {
          return json(res, 400, { error: 'MISSING_EVALUATION_ID', message: 'evaluationId is required.' });
        }

        try {
          if (hasSupabase) {
            const sub = await supabaseStore.getMlSubmissionById(evaluationId, ctx.teamId);
            if (!sub) {
              return json(res, 404, { error: 'NOT_FOUND', message: 'Submission not found or does not belong to your team.' });
            }

            if (sub.status === 'valid') {
              if (sub.qualifies_for_escape) {
                await supabaseStore.finalizeQualifyingMlSubmission({
                  submissionId: sub.id,
                  teamId: ctx.teamId,
                  delegateId: ctx.delegateId || sub.delegate_id,
                  r2Score: sub.r2_score,
                  mseScore: sub.mse_score,
                  points: CANONICAL_STAGE_SCORES.purple?.points || 1000
                });
              }
              const allSubs = await supabaseStore.getTeamSubmissions(ctx.teamId);
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: sub.r2_score,
                mseScore: sub.mse_score,
                qualifiesForEscape: sub.qualifies_for_escape,
                message: sub.qualifies_for_escape ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission finalized.',
                submissionsUsed: allSubs.length,
                submissionsRemaining: Math.max(0, 10 - allSubs.length),
                maxAllowed: 10
              });
            }

            if (sub.status === 'pending') {
              let r2 = sub.r2_score;
              let mse = sub.mse_score;
              let qualifies = sub.qualifies_for_escape;
              if (r2 === null || r2 === undefined) {
                if (!csvContent) {
                  return json(res, 400, {
                    error: 'CSV_REQUIRED_FOR_PENDING_RECONCILIATION',
                    message: 'Submission is pending evaluation score. Please provide csvContent to reconcile.'
                  });
                }
                const evalResult = evaluateSubmission(csvContent);
                if (!evalResult.valid) {
                  await supabaseStore.finalizeMlSubmission({
                    submissionId: sub.id,
                    status: 'rejected',
                    errorMessage: evalResult.error
                  });
                  return json(res, 400, { error: 'VALIDATION_FAILED', message: evalResult.error });
                }
                r2 = evalResult.r2Score;
                mse = evalResult.mseScore;
                qualifies = evalResult.qualifiesForEscape;
              }

              if (qualifies) {
                await supabaseStore.finalizeQualifyingMlSubmission({
                  submissionId: sub.id,
                  teamId: ctx.teamId,
                  delegateId: ctx.delegateId || sub.delegate_id,
                  r2Score: r2,
                  mseScore: mse,
                  points: CANONICAL_STAGE_SCORES.purple?.points || 1000
                });
              } else {
                await supabaseStore.finalizeMlSubmission({
                  submissionId: sub.id,
                  r2Score: r2,
                  mseScore: mse,
                  qualifiesForEscape: false,
                  status: 'valid'
                });
              }

              const allSubs = await supabaseStore.getTeamSubmissions(ctx.teamId);
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                message: qualifies ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission reconciled.',
                submissionsUsed: allSubs.length,
                submissionsRemaining: Math.max(0, 10 - allSubs.length),
                maxAllowed: 10
              });
            }

            return json(res, 400, { error: 'SUBMISSION_STATUS_INVALID', message: `Submission status is ${sub.status}` });
          } else {
            const state = await fallbackStore.read();
            const team = state.teams[ctx.teamId];
            if (!team) return json(res, 404, { error: 'TEAM_NOT_FOUND' });
            const sub = (team.mlSubmissions || []).find((s) => s.id === evaluationId);
            if (!sub) return json(res, 404, { error: 'NOT_FOUND', message: 'Submission not found' });

            if (sub.status === 'valid') {
              if (sub.qualifies_for_escape) {
                team.escapeUnlocked = true;
                if (!team.solvedCtfs.includes('purple-01')) {
                  team.solvedCtfs.push('purple-01');
                }
                team.completedZones = team.completedZones || [];
                if (!team.completedZones.includes('purple')) {
                  team.completedZones.push('purple');
                  team.score = (team.score || 0) + (CANONICAL_STAGE_SCORES.purple?.points || 1000);
                  team.events = team.events || [];
                  team.events.unshift({
                    at: new Date().toISOString(),
                    message: 'Sector PURPLE completed. Helicopter evacuation authorized!'
                  });
                }
                await fallbackStore.write(state);
              }
              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: sub.r2_score,
                mseScore: sub.mse_score,
                qualifiesForEscape: sub.qualifies_for_escape,
                message: sub.qualifies_for_escape ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission finalized.',
                submissionsUsed: team.mlSubmissions.length,
                submissionsRemaining: Math.max(0, 10 - team.mlSubmissions.length),
                maxAllowed: 10
              });
            }

            if (sub.status === 'pending') {
              let r2 = sub.r2_score;
              let mse = sub.mse_score;
              let qualifies = sub.qualifies_for_escape;
              if (r2 === null || r2 === undefined) {
                if (!csvContent) {
                  return json(res, 400, {
                    error: 'CSV_REQUIRED_FOR_PENDING_RECONCILIATION',
                    message: 'Submission is pending evaluation score. Please provide csvContent to reconcile.'
                  });
                }
                const evalResult = evaluateSubmission(csvContent);
                if (!evalResult.valid) {
                  sub.status = 'rejected';
                  sub.error_message = evalResult.error;
                  await fallbackStore.write(state);
                  return json(res, 400, { error: 'VALIDATION_FAILED', message: evalResult.error });
                }
                r2 = evalResult.r2Score;
                mse = evalResult.mseScore;
                qualifies = evalResult.qualifiesForEscape;
              }

              await finalizeAttemptFallback(ctx.teamId, sub.id, {
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                status: 'valid'
              });

              return json(res, 200, {
                success: true,
                reconciled: true,
                evaluationId: sub.id,
                timestamp: sub.submitted_at,
                r2Score: r2,
                mseScore: mse,
                qualifiesForEscape: qualifies,
                message: qualifies ? 'PERMIT-AUTH//TRANSIT-PURPLE-PASS' : 'Submission reconciled.',
                submissionsUsed: team.mlSubmissions.length,
                submissionsRemaining: Math.max(0, 10 - team.mlSubmissions.length),
                maxAllowed: 10
              });
            }

            return json(res, 400, { error: 'SUBMISSION_STATUS_INVALID', message: `Submission status is ${sub.status}` });
          }
        } catch (recErr) {
          console.error('[reconcile error]', recErr);
          return json(res, 500, { error: 'RECONCILE_FAILED', message: recErr.message });
        }
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
        let board;
        if (hasSupabase) {
          board = await supabaseStore.getLeaderboard();
        } else {
          const state = await fallbackStore.read();
          board = Object.values(state.teams || {}).map((t) => {
            const escapeUnlocked = (t.completedZones || []).includes('purple') || (t.mlSubmissions || []).some((s) => s.qualifies_for_escape);
            const bestR2 = (t.mlSubmissions || []).reduce((max, s) => s.r2_score !== null && s.r2_score > max ? s.r2_score : max, null);
            return {
              team_id: t.id,
              team_name: t.name || t.id,
              total_score: t.score || 0,
              best_r2_score: bestR2,
              escape_unlocked: escapeUnlocked,
              last_score_at: t.lastScoreAt || null
            };
          }).sort((a, b) => b.total_score - a.total_score || (b.best_r2_score || 0) - (a.best_r2_score || 0));
        }
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
        const allZoneIds = found.zone.ctfs.map((c) => c.id);
        const stagePoints = 0; // Scoring ownership belongs strictly to zone completion RPCs

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId,
            delegateId: body.delegateId || null,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: stagePoints,
            allZoneChallenges: allZoneIds,
            nextZoneId: ZONE_NEXT_MAP[found.zone.id] || null,
            rewardDatasetKey: ZONE_REWARD_DATASETS[found.zone.id] || null
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

        const allZoneIds = found.zone.ctfs.map((c) => c.id);
        const stagePoints = 0; // Scoring ownership belongs strictly to zone completion RPCs

        if (hasSupabase) {
          const rpcResult = await supabaseStore.completeChallenge({
            teamId: ctx.teamId,
            delegateId: ctx.delegateId,
            zoneId: found.zone.id,
            challengeId: found.ctf.id,
            points: stagePoints,
            allZoneChallenges: allZoneIds,
            nextZoneId: ZONE_NEXT_MAP[found.zone.id] || null,
            rewardDatasetKey: ZONE_REWARD_DATASETS[found.zone.id] || null
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
      // 11.5 ADMIN ENDPOINTS (Protected with Admin Key or Admin Session)
      // -------------------------------------------------------------------
      if (pathname === '/api/admin/session' && req.method === 'GET') {
        const authed = isAuthorizedAdmin(req, url);
        return json(res, 200, { ok: true, authenticated: authed });
      }

      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const body = await readBody(req);
        const adminKey = body.adminKey || body.key;
        const expectedKey = getExpectedAdminKey();

        if (!expectedKey || !adminKey || !safeEqual(crypto.createHash('sha256').update(String(adminKey)).digest('hex'), crypto.createHash('sha256').update(String(expectedKey)).digest('hex'))) {
          return json(res, 401, { error: 'INVALID_ADMIN_KEY', message: 'Invalid admin master key.' });
        }

        setAdminSessionCookie(res);
        return json(res, 200, { ok: true, message: 'Admin authentication successful' });
      }

      if (pathname === '/api/admin/logout' && req.method === 'POST') {
        clearAdminSessionCookie(res);
        return json(res, 200, { ok: true, message: 'Admin session terminated' });
      }

      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        if (!isAuthorizedAdmin(req, url)) {
          return json(res, 401, { error: 'UNAUTHORIZED', message: 'Valid x-admin-key header or admin session required.' });
        }

        if (hasSupabase) {
          try {
            const overview = await supabaseStore.getAdminOverview();
            return json(res, 200, { ok: true, totalPointsPossible: TOTAL_COMPETITION_POINTS, ...overview });
          } catch (err) {
            return json(res, 500, { error: 'ADMIN_QUERY_FAILED', message: err.message });
          }
        } else {
          const state = await fallbackStore.read();
          const overview = buildFallbackAdminOverview(state);
          return json(res, 200, { ok: true, totalPointsPossible: TOTAL_COMPETITION_POINTS, ...overview });
        }
      }

      // -------------------------------------------------------------------
      // 12. STATIC FILES & HTML (PRESERVED THREE.JS / SCENE FILES)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }

      let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
        relative = path.join('admin', 'index.html');
      }
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
        const staticMap = {
          'index.html': path.join(publicDir, 'index.html'),
          'admin': path.join(publicDir, 'admin', 'index.html'),
          'admin/': path.join(publicDir, 'admin', 'index.html'),
          'admin.html': path.join(publicDir, 'admin', 'index.html'),
          [path.join('admin', 'index.html')]: path.join(publicDir, 'admin', 'index.html'),
          'admin/admin.css': path.join(publicDir, 'admin', 'admin.css'),
          'admin/admin.js': path.join(publicDir, 'admin', 'admin.js'),
          'app.js': path.join(publicDir, 'app.js'),
          'styles.css': path.join(publicDir, 'styles.css'),
          'scene.js': path.join(publicDir, 'scene.js'),
          'mock-ctf.js': path.join(publicDir, 'mock-ctf.js')
        };
        actualPath = staticMap[relative] || actualPath;
      }
      if (!actualPath || !actualPath.startsWith(staticRoot) || !fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) {
        res.writeHead(404);
        return res.end('Not found');
      }

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
