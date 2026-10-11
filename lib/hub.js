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
  const hasSupabase = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

  if (isProduction && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new Error('Production requires SESSION_SECRET with at least 32 characters.');
  }
  const sessionSecret = env.SESSION_SECRET || 'development-only-session-secret-change-before-deploy-4f89a6b3';

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

  function setSessionCookie(res, sessionId) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=${signSession(sessionId, sessionSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
  }

  function clearSessionCookie(res) {
    const secure = env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && isProduction);
    res.setHeader('Set-Cookie', `td_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
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

    const sid = verifySessionCookie(cookies.td_session, sessionSecret);
    if (!sid) return { sid: null, session: null, team: null, teamId: null, delegateId: null };

    if (hasSupabase) {
      const active = await supabaseStore.validateSession(sid);
      if (!active) return { sid: null, session: null, team: null, teamId: null, delegateId: null };
      return {
        sid,
        session: active,
        team: active.team,
        teamId: active.teamId,
        delegateId: active.delegateId,
        isSupabase: true
      };
    } else {
      const state = await fallbackStore.read();
      const session = state.sessions[sid];
      if (!session || !state.teams[session.teamId]) return { sid: null, session: null, team: null, teamId: null, delegateId: null };
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
  }

  function rateLimit(req, key, max, windowMs) {
    const now = Date.now();
    const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
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
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
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

  function commonHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; media-src 'self' blob:; frame-src 'self' http: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
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
        if (!ctx.teamId) return json(res, 200, publicBootstrap());
        if (hasSupabase) {
          const bootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
          return json(res, 200, bootstrap);
        } else {
          return json(res, 200, { authenticated: true, team: ctx.team, serverTime: new Date().toISOString() });
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
          return json(res, 200, bootstrap);
        } else {
          // Fallback legacy development registration
          const rawId = canonicalTeamId(teamId);
          const state = await fallbackStore.read();
          let team = state.teams[rawId];
          if (!team) {
            team = { id: rawId, name: body.teamName || rawId, createdAt: new Date().toISOString(), solvedCtfs: [], events: [] };
            state.teams[rawId] = team;
          }
          const sid = randomId();
          state.sessions[sid] = { teamId: rawId, createdAt: new Date().toISOString(), view: { screen: 'map' } };
          await fallbackStore.write(state);
          setSessionCookie(res, sid);
          return json(res, 200, { authenticated: true, team });
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

        const { supabase } = require('./supabaseClient');
        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'sanctuary',
            status: 'completed',
            updated_at: new Date().toISOString()
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'yellow',
            status: 'available',
            updated_at: new Date().toISOString()
          }, { onConflict: 'team_id,zone_id' });

        const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
        return json(res, 200, { ok: true, bootstrap: nextBootstrap });
      }

      // -------------------------------------------------------------------
      // 7.15 YELLOW COMPLETION (Unlocks Blue Zone & community_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/yellow/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        const { supabase } = require('./supabaseClient');
        const now = new Date().toISOString();

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'yellow',
            status: 'completed',
            completed_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'blue',
            status: 'available',
            unlocked_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('dataset_entitlements')
          .upsert({
            team_id: ctx.teamId,
            dataset_key: 'community_final'
          }, { onConflict: 'team_id,dataset_key' });

        await supabase
          .from('score_ledger')
          .insert({
            team_id: ctx.teamId,
            points: 20,
            source: 'zone_yellow_clear',
            created_at: now
          }).catch(() => undefined);

        const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
        return json(res, 200, { ok: true, bootstrap: nextBootstrap });
      }

      // -------------------------------------------------------------------
      // 7.16 BLUE COMPLETION (Unlocks Orange Zone & radio_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/blue/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        const { supabase } = require('./supabaseClient');
        const now = new Date().toISOString();

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'blue',
            status: 'completed',
            completed_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'orange',
            status: 'available',
            unlocked_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('dataset_entitlements')
          .upsert({
            team_id: ctx.teamId,
            dataset_key: 'radio_final'
          }, { onConflict: 'team_id,dataset_key' });

        await supabase
          .from('score_ledger')
          .insert({
            team_id: ctx.teamId,
            points: 20,
            source: 'zone_blue_clear',
            created_at: now
          }).catch(() => undefined);

        const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
        return json(res, 200, { ok: true, bootstrap: nextBootstrap });
      }

      // -------------------------------------------------------------------
      // 7.17 ORANGE COMPLETION (Unlocks Red Zone & forensics_final dataset)
      // -------------------------------------------------------------------
      if (pathname === '/api/orange/complete' && req.method === 'POST') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in first.' });

        const { supabase } = require('./supabaseClient');
        const now = new Date().toISOString();

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'orange',
            status: 'completed',
            completed_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('zone_progress')
          .upsert({
            team_id: ctx.teamId,
            zone_id: 'red',
            status: 'available',
            unlocked_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });

        await supabase
          .from('dataset_entitlements')
          .upsert({
            team_id: ctx.teamId,
            dataset_key: 'forensics_final'
          }, { onConflict: 'team_id,dataset_key' });

        await supabase
          .from('score_ledger')
          .insert({
            team_id: ctx.teamId,
            points: 20,
            source: 'zone_orange_clear',
            created_at: now
          }).catch(() => undefined);

        const nextBootstrap = await supabaseStore.getTeamBootstrap(ctx.teamId, ctx.delegateId, config);
        return json(res, 200, { ok: true, bootstrap: nextBootstrap });
      }

      // -------------------------------------------------------------------
      // 7.2 DATASET ENTITLEMENTS & DOWNLOAD (Strict Server-Side Gate)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/dataset/') && req.method === 'GET') {
        if (!ctx.teamId) return json(res, 401, { error: 'AUTH_REQUIRED', message: 'You must log in to download datasets.' });
        const datasetKey = pathname.slice('/api/dataset/'.length).replace(/\.csv$/, '');

        const validDatasets = ['community_final', 'radio_final', 'forensics_final', 'research_final', 'train'];
        if (!validDatasets.includes(datasetKey)) {
          return json(res, 404, { error: 'DATASET_NOT_FOUND' });
        }

        // train.csv is given ONLY in Purple Zone
        if (datasetKey === 'train') {
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
        if (!rateLimit(req, `ml-sub:${ctx.teamId}`, 15, 60 * 60_000)) {
          return json(res, 429, { error: 'SUBMISSION_LIMIT_EXCEEDED', message: 'Max 15 submissions per hour.' });
        }

        const body = await readBody(req);
        const csvContent = body.csvContent || body.raw || '';
        const rawFilename = body.rawFilename || 'submission.csv';

        const evalResult = evaluateSubmission(csvContent);

        if (!evalResult.valid) {
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
          return json(res, 400, { error: 'VALIDATION_FAILED', message: evalResult.error });
        }

        // Record successful evaluation
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

        return json(res, 200, {
          success: true,
          r2Score: evalResult.r2Score,
          mseScore: evalResult.mseScore,
          qualifiesForEscape: evalResult.qualifiesForEscape,
          threshold: evalResult.threshold,
          message: evalResult.message
        });
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
      }

      // -------------------------------------------------------------------
      // 12. STATIC FILES & HTML (PRESERVED THREE.JS / SCENE FILES)
      // -------------------------------------------------------------------
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'NOT_FOUND' });
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }

      let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(publicDir, relative);
      if (!filePath.startsWith(staticRoot)) { res.writeHead(403); return res.end('Forbidden'); }

      let actualPath = filePath;
      if (!fs.existsSync(actualPath) || !fs.statSync(actualPath).isFile()) actualPath = path.join(publicDir, 'index.html');
      if (!fs.existsSync(actualPath)) { res.writeHead(404); return res.end('Not found'); }

      const stat = fs.statSync(actualPath);
      const ext = path.extname(actualPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(actualPath).pipe(res);
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
