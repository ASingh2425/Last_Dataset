(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const queryAll = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const zonesHost = $('#zone-nodes');
  const worldMap = $('#world-map');
  const mapStage = $('#map-stage');
  const screens = ['hero', 'registration', 'map', 'zone', 'ctf'];
  const zoneIcons = { yellow: '⚠', blue: '≈', orange: '⌁', red: '✣', purple: '⌘' };
  let hub = null;
  let currentZoneData = null;
  let activeCtf = null;
  let expectedCtfOrigin = null;
  let ctfLoadTimeout = null;
  let transitionBusy = false;
  let previousZoneStates = null;
  let pendingUnlock = null;
  let zoom = 1, panX = 0, panY = 0, drag = null;
  let noticeTimer = null;

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function storageGet(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private/opaque browser contexts may disable storage */ } }
  function storageRemove(key) { try { window.localStorage.removeItem(key); } catch { /* private/opaque browser contexts may disable storage */ } }
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const fmtTime = (value) => { try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return '--:--'; } };
  async function api(url, options = {}) {
    const headers = options.body === undefined
      ? { 'Accept': 'application/json' }
      : { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    const sid = options.sessionId || storageGet('tld_session_id');
    const tid = options.teamId || storageGet('tld_team_id');
    const did = options.delegateId || storageGet('tld_delegate_id');
    if (sid) headers['x-session-id'] = sid;
    if (tid) headers['x-team-id'] = tid;
    if (did) headers['x-delegate-id'] = did;

    const response = await fetch(url, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let body = {};
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) body = await response.json();
    if (!response.ok) {
      const err = new Error(body.message || body.error || `Request failed (${response.status})`);
      err.status = response.status; err.code = body.error; throw err;
    }
    return body;
  }
  function setScreen(screen) {
    screens.forEach((name) => {
      const node = $(`#screen-${name}`);
      if (node) node.hidden = name !== screen;
    });
    document.body.dataset.screen = screen;
    if (window.TLDScene) window.TLDScene.setMode(screen);
    document.title = `${screen === 'hero' ? 'THE LAST DATASET' : screen === 'registration' ? 'SANCTUARY CHECK-IN' : screen === 'map' ? 'PRALAYA // WORLD MAP' : screen === 'zone' ? 'QUARANTINE ZONE' : 'CHALLENGE TERMINAL'} // SURVIVOR NETWORK`;
    if (screen === 'map') updateMapTransform();
  }
  async function navigate(screen, options = {}) {
    if (transitionBusy && !options.force) return;
    transitionBusy = true;
    const auth = !!hub?.authenticated;
    try {
      if (auth && options.saveView !== false && ['map', 'zone'].includes(screen)) {
        const body = screen === 'zone' ? { screen, zoneId: options.zoneId } : { screen };
        await api('/api/view', { method: 'POST', body });
      }
      if (screen === 'map') history.replaceState(null, '', '/#map');
      if (screen === 'registration') history.replaceState(null, '', '/#registration');
      if (screen === 'hero') history.replaceState(null, '', '/');
      if (!options.instant && !reducedMotion) {
        $('#transition-flash').classList.remove('go');
        void $('#transition-flash').offsetWidth;
        $('#transition-flash').classList.add('go');
        await sleep(250);
      }
      setScreen(screen);
      if (screen === 'map') {
        $('#map-region-label').textContent = 'REGION 00 / SANCTUARY';
        $('#map-region-subtitle').textContent = 'SECTOR MAP · LIVE RECOVERY FEED';
        updateHUD();
      }
      if (screen === 'hero') {
        $('.torch-reticle').style.display = '';
        typeTransmission(0);
      } else $('.torch-reticle').style.display = 'none';
    } catch (error) {
      toast(error.message || 'The route could not be established.', true);
    } finally { transitionBusy = false; }
  }
  function toast(message, error = false) {
    const notice = $('#notice');
    notice.textContent = message;
    notice.classList.toggle('error', error);
    notice.classList.add('show');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.classList.remove('show'), 3800);
  }
  function setQuality(value) {
    document.body.dataset.quality = value;
    storageSet('tld-quality', value);
    $('#hud-quality').setAttribute('aria-pressed', value === 'high' ? 'true' : 'false');
    $('#hud-quality').innerHTML = `◈ EFFECTS <b>${value.toUpperCase()}</b>`;
    if (window.TLDScene) window.TLDScene.setQuality(value);
  }
  function setClarity(enabled) {
    document.body.dataset.clarity = String(enabled);
    storageSet('tld-clarity', String(enabled));
    $('#clarity-toggle').setAttribute('aria-pressed', String(enabled));
    $('#clarity-toggle').textContent = enabled ? '◌ CLARITY ON' : '◌ CLARITY';
    if (window.TLDScene) window.TLDScene.setClarity(enabled);
  }
  function setSound(enabled) {
    if (window.TLDScene) window.TLDScene.setSound(enabled);
    $('#hero-sound').setAttribute('aria-pressed', String(enabled));
    $('#hero-sound').textContent = enabled ? '◖ SOUND ON' : '◖ SOUND OFF';
    $('#hud-sound').setAttribute('aria-pressed', String(enabled));
    $('#hud-sound').innerHTML = `◖ SOUND <b>${enabled ? 'ON' : 'OFF'}</b>`;
    storageSet('tld-sound-opt-in', String(enabled));
  }
  function isZoneUnlocked(zoneId) { return !!hub?.zones?.find((zone) => zone.id === zoneId)?.unlocked; }
  function zoneById(zoneId) { return hub?.zones?.find((zone) => zone.id === zoneId); }
  function updateMapTransform() {
    if (worldMap) worldMap.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  }
  function svgNode(zone) {
    const x = Math.round(zone.position.x * 12), y = Math.round(zone.position.y * 7.6);
    const progress = zone.ctfTotal ? zone.solved / zone.ctfTotal : 0;
    const circumference = 2 * Math.PI * 44;
    const offset = circumference * (1 - progress);
    const statusLabel = zone.state === 'locked' ? 'ZONE ACCESS LOCKED' : zone.state === 'cleared' ? 'ZONE CLEARED' : 'ACCESS AVAILABLE';
    const lock = zone.state === 'locked' ? `<g transform="translate(0,-1)"><rect class="lock-plate" x="-17" y="-15" width="34" height="31" rx="2" stroke-width="1"/><text class="lock-mark" x="0" y="4" text-anchor="middle">▣</text></g>` : '';
    const mark = zone.state === 'cleared' ? `<text class="zone-flag" x="0" y="5">✓</text>` : zone.state === 'locked' ? '' : `<text class="zone-symbol" x="0" y="1">${zoneIcons[zone.id] || '◇'}</text>`;
    return `<g class="zone-node ${zone.state === 'locked' ? 'locked' : ''} ${zone.state === 'cleared' ? 'cleared' : ''}" data-zone-id="${escapeHTML(zone.id)}" role="button" tabindex="0" aria-label="${escapeHTML(zone.name)} — ${escapeHTML(statusLabel)}" aria-disabled="${zone.unlocked ? 'false' : 'true'}" transform="translate(${x} ${y})" style="color:${escapeHTML(zone.color)}"><circle class="node-halo" r="66"/><circle class="node-ring" r="49"/><circle class="node-core" r="39"/><circle class="node-inner" r="31"/><circle class="progress-arc" r="44" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/><circle r="57" fill="none" stroke="currentColor" stroke-opacity=".15" stroke-dasharray="2 12"/>${lock}${mark}<text class="node-name" x="0" y="70">${escapeHTML(zone.name)}</text><text class="node-subtitle" x="0" y="85">${escapeHTML(statusLabel)}</text></g>`;
  }
  function renderMapNodes() {
    if (!hub?.zones || !zonesHost) return;
    zonesHost.innerHTML = hub.zones.map(svgNode).join('');
    hub.zones.forEach((zone) => {
      const route = $(`#route-${zone.id}`);
      if (route) route.classList.toggle('is-lit', zone.unlocked);
    });
    queryAll('.zone-node', zonesHost).forEach((node) => {
      const zoneId = node.dataset.zoneId;
      node.addEventListener('click', () => { if (!isZoneUnlocked(zoneId)) showDenied(zoneId); else travelToZone(zoneId); });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!isZoneUnlocked(zoneId)) showDenied(zoneId); else travelToZone(zoneId); }
      });
      node.addEventListener('pointerenter', (event) => showTooltip(zoneId, event));
      node.addEventListener('pointermove', (event) => positionTooltip(event));
      node.addEventListener('pointerleave', hideTooltip);
      node.addEventListener('focus', () => showTooltipForFocus(zoneId, node));
      node.addEventListener('blur', hideTooltip);
    });
  }
  function showTooltip(zoneId, event) {
    const zone = zoneById(zoneId); if (!zone) return;
    const tip = $('#map-tooltip'); tip.hidden = false;
    tip.innerHTML = `<strong style="color:${escapeHTML(zone.color)}">${escapeHTML(zone.name)}</strong>${zone.unlocked ? (zone.state === 'cleared' ? 'ZONE CLEARED · FRAGMENT SECURED' : 'SECTOR UNLOCKED · CLICK TO ACCESS') : 'ZONE ACCESS LOCKED: COMPLETE SANCTUARY STORYLINE BRIEFING FIRST'}`;
    positionTooltip(event);
  }
  function positionTooltip(event) {
    const tip = $('#map-tooltip'); if (tip.hidden || !event.clientX) return;
    const rect = mapStage.getBoundingClientRect();
    tip.style.left = `${Math.min(event.clientX - rect.left + 12, rect.width - tip.offsetWidth - 12)}px`;
    tip.style.top = `${Math.min(event.clientY - rect.top + 10, rect.height - tip.offsetHeight - 12)}px`;
  }
  function showTooltipForFocus(zoneId, node) {
    const rect = node.getBoundingClientRect();
    showTooltip(zoneId, { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
  }
  function hideTooltip() { $('#map-tooltip').hidden = true; }
  let deniedTimer = null;
  function showDenied(zoneId) {
    const zone = zoneById(zoneId);
    const denied = $('#map-denied');
    denied.hidden = false;
    denied.classList.remove('shake');
    void denied.offsetWidth;
    denied.classList.add('shake');
    $('#map-region-label').textContent = zone ? `REGION ${String(zone.order).padStart(2, '0')} / ZONE ACCESS LOCKED` : 'ZONE ACCESS LOCKED';
    const sub = $('#map-denied-sub');
    if (sub) {
      if (zoneId === 'yellow' && !hub?.sanctuaryCompleted) {
        sub.textContent = 'COMPLETE THE SANCTUARY STORYLINE & SOLVE GATE CTF TO ACCESS YELLOW ZONE';
      } else if (zoneId === 'blue') {
        sub.textContent = 'CLEAR ALL 5 YELLOW ZONE CTFS & RETRIEVE COMMUNITY FRAGMENT TO ACCESS BLUE ZONE';
      } else {
        sub.textContent = !hub?.sanctuaryCompleted
          ? 'COMPLETE THE SANCTUARY STORYLINE BRIEFING TO ACCESS QUARANTINE ZONES'
          : 'CLEAR THE PREVIOUS ZONE TO ACCESS THIS SECTOR';
      }
    }
    toast(zoneId === 'yellow' && !hub?.sanctuaryCompleted ? 'ZONE ACCESS LOCKED: Complete Sanctuary and solve gate CTF first.' : 'ZONE ACCESS LOCKED: Clear previous zone first.', true);
    if (window.TLDScene) window.TLDScene.lurch();
    clearTimeout(deniedTimer);
    deniedTimer = setTimeout(() => {
      denied.hidden = true;
      $('#map-region-label').textContent = 'REGION 00 / SANCTUARY';
    }, 2800);
  }
  const ZONE_URLS = {
    yellow: 'https://yellowzone-xi.vercel.app',
    blue: 'https://bluezone-xi.vercel.app/',
    orange: 'https://or-light-gamma.vercel.app/',
    red: 'https://red-five-liart.vercel.app/',
    purple: '/purple'
  };

  const STORY_TRANSITIONS = {
    yellow: 'https://yellow-to-blue-slideshow.vercel.app/',
    blue: 'https://blue-orange-slideshow-ogib.vercel.app/transition/radio-forensics',
    orange: 'https://orange-to-red-slideshow.vercel.app/transition/radio-forensics',
    red: 'https://red-purple-slideshow.vercel.app/'
  };

  async function travelToZone(zoneId) {
    if (!hub?.authenticated) {
      toast('AUTHENTICATION REQUIRED: PLEASE LOG IN WITH YOUR TEAM CREDENTIALS.', true);
      await navigate('registration');
      return;
    }
    const zone = zoneById(zoneId); if (!zone) return;
    if (!zone.unlocked) return showDenied(zoneId);
    hideTooltip();
    const path = $(`#route-${zoneId}`);
    const marker = $('#traveller'); const ring = $('#traveller-ring');
    if (!reducedMotion && path && path.getTotalLength) {
      const length = path.getTotalLength(); const start = performance.now(); const duration = 800;
      marker.style.opacity = '1'; ring.style.opacity = '1';
      await new Promise((resolve) => {
        const step = (now) => {
          const p = Math.min(1, (now - start) / duration); const eased = 1 - Math.pow(1 - p, 3);
          const point = path.getPointAtLength(length * eased); marker.setAttribute('cx', point.x); marker.setAttribute('cy', point.y); ring.setAttribute('cx', point.x); ring.setAttribute('cy', point.y);
          if (p < 1) requestAnimationFrame(step); else resolve();
        }; requestAnimationFrame(step);
      });
    } else { const p = { x: zone.position.x * 12, y: zone.position.y * 7.6 }; marker.setAttribute('cx', p.x); marker.setAttribute('cy', p.y); ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y); }
    $('#map-region-label').textContent = `REGION ${String(zone.order).padStart(2, '0')} / ${zone.name}`;
    $('#map-region-subtitle').textContent = zone.tagline;

    const targetUrl = ZONE_URLS[zoneId] || zone.url;
    if (targetUrl) {
      const urlWithTeam = hub?.team?.id
        ? `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}team=${encodeURIComponent(hub.team.id)}`
        : targetUrl;
      window.open(urlWithTeam, '_blank', 'noopener,noreferrer');
      toast(`DISPATCHED TO ${zone.name} ↗ (ACTIVE IN NEW TAB)`);
    } else {
      await showZone(zoneId);
    }
  }
  async function showZone(zoneId, options = {}) {
    try {
      if (options.saveView !== false) await api('/api/view', { method: 'POST', body: { screen: 'zone', zoneId } });
      const data = await api(`/api/zones/${encodeURIComponent(zoneId)}`);
      currentZoneData = data;
      const zone = data.zone;
      $('#zone-heading').textContent = zone.name;
      const name = zone.name.replace(/\s+ZONE$/i, '');
      $('#zone-title').innerHTML = `${escapeHTML(name)}<br><span>ZONE</span>`;
      $('#zone-description').textContent = zone.terrain;
      $('#zone-coordinates').textContent = `SECTOR ${String(zone.order).padStart(2, '0')} · ${zone.tagline}`;
      $('#zone-signal').textContent = zone.state === 'cleared' ? 'ALL SIGNALS RECOVERED' : 'SIGNAL AVAILABLE';
      $('#zone-landscape').style.setProperty('--active-zone', zone.color);
      const percent = Math.round(zone.solved / zone.ctfTotal * 100);
      $('#zone-progress-count').textContent = `${zone.solved} / ${zone.ctfTotal} DATASETS RECOVERED`;
      $('#zone-progress-fill').style.width = `${percent}%`;
      $('#zone-progress-percent').textContent = `${String(percent).padStart(2, '0')}%`;
      $('#zone-bottom-state').textContent = zone.state === 'cleared' ? 'QUARANTINE STATUS: CLEARED' : 'QUARANTINE STATUS: OPEN';
      renderTerminals(data);
      if (hub) hub.view = { screen: 'zone', zoneId };
      await navigate('zone', { saveView: false, instant: options.instant });
    } catch (error) {
      if (error.status === 403) { showDenied(zoneId); await navigate('map', { saveView: false, force: true }); }
      else toast(error.message || 'The zone signal is unavailable.', true);
    }
  }
  function renderTerminals(data) {
    const host = $('#zone-terminal-list');
    host.innerHTML = data.ctfs.map((ctf, index) => `<button class="ctf-object ${ctf.solved ? 'solved' : ''}" data-ctf-id="${escapeHTML(ctf.id)}" aria-label="Open ${escapeHTML(ctf.title)}${ctf.solved ? ', solved' : ''}"><span class="terminal-art" aria-hidden="true">${['▤', '⌘', '⎔'][index % 3]}</span><span class="ctf-object-copy"><small>TERMINAL ${String(index + 1).padStart(2, '0')} // ${ctf.solved ? 'RECOVERED' : 'AWAITING RECOVERY'}</small><b>${escapeHTML(ctf.title)}</b><span>${escapeHTML(ctf.briefing)}</span>${hub?.devToolsEnabled && !ctf.solved ? `<span class="dev-solve" data-dev-solve="${escapeHTML(ctf.id)}">[ DEV SIMULATION: SOLVE ]</span>` : ''}</span><span class="ctf-object-arrow" aria-hidden="true">${ctf.solved ? '✓' : '↗'}</span></button>`).join('');
    queryAll('.ctf-object', host).forEach((item) => {
      item.addEventListener('click', (event) => {
        const devButton = event.target.closest('[data-dev-solve]');
        if (devButton) { event.preventDefault(); event.stopPropagation(); return devSolve(devButton.dataset.devSolve); }
        openCtf(item.dataset.ctfId);
      });
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter') openCtf(item.dataset.ctfId); });
    });
  }
  async function devSolve(ctfId) {
    try {
      const result = await api('/api/dev/solve', { method: 'POST', body: { ctfId } });
      const willUnlock = result.bootstrap.zones.some((zone) => zone.unlocked && !isZoneUnlocked(zone.id));
      applyBootstrap(result.bootstrap, { animate: true });
      toast(result.newlySolved ? 'DEV SIMULATION ACCEPTED · SERVER PROGRESS UPDATED.' : 'THIS DATASET IS ALREADY RECOVERED.');
      const zoneId = currentZoneData?.zone?.id;
      if (zoneId && !willUnlock && !result.bootstrap.progress.complete) await showZone(zoneId, { saveView: false, instant: true });
    } catch (error) { toast(error.message || 'Simulation rejected.', true); }
  }
  async function openCtf(ctfId, options = {}) {
    try {
      const result = await api(`/api/ctfs/${encodeURIComponent(ctfId)}/open`, { method: 'POST', body: {} });
      activeCtf = result;
      hub.view = { screen: 'ctf', zoneId: result.zone.id, ctfId: result.ctf.id };
      $('#ctf-frame-ctf').textContent = result.ctf.title;
      $('#ctf-frame-zone').textContent = `${result.zone.name} / FIELD TERMINAL`;
      $('#ctf-frame-status').textContent = result.ctf.solved ? 'RECORD RECOVERED · REPLAY' : 'SIGNAL CONNECTING';
      $('#ctf-signal-lost').hidden = true; $('#ctf-loading').hidden = false; $('#ctf-iframe').hidden = true;
      const resolved = new URL(result.url, window.location.href);
      expectedCtfOrigin = resolved.origin;
      $('#ctf-new-tab').href = resolved.href;
      $('#ctf-lost-new-tab').href = resolved.href;
      await navigate('ctf', { saveView: false, instant: options.instant });
      loadIframe(resolved.href);
    } catch (error) {
      if (error.status === 403) toast('QUARANTINE SEALED · CLEAR THE PREVIOUS ZONE FIRST.', true);
      else toast(error.message || 'The terminal could not be opened.', true);
    }
  }
  function loadIframe(href) {
    clearTimeout(ctfLoadTimeout);
    const frame = $('#ctf-iframe');
    $('#ctf-loading').hidden = false; $('#ctf-signal-lost').hidden = true; frame.hidden = true;
    frame.onload = () => {
      clearTimeout(ctfLoadTimeout);
      $('#ctf-loading').hidden = true; frame.hidden = false;
      $('#ctf-frame-status').textContent = 'SIGNAL ESTABLISHED';
    };
    frame.onerror = () => showSignalLost();
    frame.src = href;
    ctfLoadTimeout = setTimeout(() => { if ($('#ctf-loading').hidden === false) showSignalLost(); }, 14000);
  }
  function showSignalLost() {
    clearTimeout(ctfLoadTimeout);
    $('#ctf-loading').hidden = true; $('#ctf-iframe').hidden = true; $('#ctf-signal-lost').hidden = false;
    $('#ctf-frame-status').textContent = 'SIGNAL LOST';
  }
  async function backToMap() {
    clearTimeout(ctfLoadTimeout);
    const frame = $('#ctf-iframe'); frame.src = 'about:blank';
    await navigate('map', { saveView: true, force: true });
    await refreshBootstrap({ animate: true });
    const states = hub?.zones || [];
    const first = states.find((zone) => zone.state === 'available' || zone.state === 'in-progress');
    if (first) { $('#traveller').setAttribute('cx', '600'); $('#traveller').setAttribute('cy', '383'); $('#traveller-ring').setAttribute('cx', '600'); $('#traveller-ring').setAttribute('cy', '383'); }
  }
  function updateBriefingGateStatus() {
    const dot = $('#briefing-gate-dot');
    const text = $('#briefing-gate-text');
    const storylineBtn = $('#briefing-storyline-btn');
    const gateBtn = $('#briefing-gate-btn');
    const currentTeam = hub?.team?.id || storageGet('tld_team_id');
    const teamParam = currentTeam ? `?team=${encodeURIComponent(currentTeam)}` : '';

    if (storylineBtn) storylineBtn.href = `https://intro-stroyline.vercel.app/${teamParam}`;
    if (gateBtn) gateBtn.href = `https://last-dataset-sanc.vercel.app/${teamParam}`;

    if (!dot || !text) return;
    if (hub?.sanctuaryCompleted) {
      dot.style.background = '#4ade80';
      dot.style.boxShadow = '0 0 6px #4ade80';
      text.textContent = 'GATE STATUS: VERIFIED · YELLOW ZONE UNLOCKED';
    } else {
      dot.style.background = '#ef4444';
      dot.style.boxShadow = '0 0 6px #ef4444';
      text.textContent = 'GATE ACCESS LOCKED · SOLVE SANCTUARY CTF';
    }
  }
  function updateHUD() {
    const topTeamText = $('#topbar-team-text');
    const topTeamInfo = $('#topbar-team-info');
    const topDot = $('#topbar-signal-dot');
    if (!hub?.authenticated) {
      if (topTeamText) topTeamText.innerHTML = '<a href="#registration" style="color:#fca5a5;text-decoration:none;">NOT AUTHENTICATED · CHECK IN →</a>';
      if (topTeamInfo) {
        topTeamInfo.style.background = 'rgba(239, 68, 68, 0.12)';
        topTeamInfo.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        topTeamInfo.style.color = '#fca5a5';
      }
      if (topDot) {
        topDot.style.background = '#ef4444';
        topDot.style.boxShadow = '0 0 6px #ef4444';
      }
      $('#hud-team-name').textContent = 'NOT LOGGED IN';
      $('#hud-team-id').innerHTML = '<a href="#registration" style="color:#fcd34d;text-decoration:underline;cursor:pointer;">ENTER CREDENTIALS →</a>';
      $('#progress-value').textContent = '0/4';
      $('#progress-heading').textContent = 'THE RECOVERY';
      $('#progress-caption').textContent = 'AUTHENTICATION REQUIRED';
      renderMapNodes();
      updateCountdown();
      return;
    }
    const playerLabel = hub.player?.delegateId ? ` · OP ${hub.player.delegateId}` : '';
    const scoreLabel = hub.score?.total !== undefined ? ` · ${hub.score.total} PTS` : ' · 0 PTS';
    const fullBadge = `${hub.team.id}${playerLabel}${scoreLabel}`;
    $('#hud-team-name').textContent = hub.team.name;
    $('#hud-team-id').textContent = fullBadge;
    if (topTeamText) topTeamText.textContent = `AUTHENTICATED: ${hub.team.name.toUpperCase()} (${hub.team.id}${playerLabel} · ${hub.score?.total || 0} PTS)`;
    if (topTeamInfo) {
      topTeamInfo.style.background = 'rgba(74, 222, 128, 0.12)';
      topTeamInfo.style.borderColor = 'rgba(74, 222, 128, 0.4)';
      topTeamInfo.style.color = '#4ade80';
    }
    if (topDot) {
      topDot.style.background = '#4ade80';
      topDot.style.boxShadow = '0 0 6px #4ade80';
    }
    $('#progress-value').textContent = `${hub.progress.solved}/${hub.progress.total}`;
    $('#progress-heading').textContent = hub.progress.complete ? 'WORLD RESTORED' : 'THE RECOVERY';
    $('#progress-caption').textContent = hub.progress.complete ? 'ALL FRAGMENTS RECOVERED' : `${hub.progress.total - hub.progress.solved} FRAGMENTS REMAIN`;
    $('#progress-bar').style.width = `${Math.round(hub.progress.ratio * 100)}%`;
    $('#ring-progress').style.strokeDashoffset = `${226.2 * (1 - hub.progress.ratio)}`;
    const current = hub.zones.find((zone) => zone.unlocked && zone.state !== 'cleared') || [...hub.zones].reverse().find((zone) => zone.state === 'cleared') || hub.zones[0];
    $('#hud-objective-title').textContent = hub.progress.complete ? 'RECOVERY COMPLETE' : `ENTER ${current.name}`;
    $('#hud-objective-copy').textContent = hub.progress.complete ? 'Every surviving record has been recovered.' : current.state === 'cleared' ? 'Quarantine breached. Proceed to next sector.' : 'Recover the surviving data fragment.';
    $('#zones-count').textContent = `${String(hub.zones.filter((zone) => zone.unlocked).length).padStart(2, '0')} / 05`;
    $('#hud-zone-list').innerHTML = hub.zones.map((zone) => `<button class="hud-zone-row ${zone.state === 'cleared' ? 'cleared' : ''}" data-hud-zone="${escapeHTML(zone.id)}" style="--zone:${escapeHTML(zone.color)}" ${zone.unlocked ? '' : 'disabled'} aria-label="${escapeHTML(zone.name)}, ${escapeHTML(zone.state)}"><span class="zone-chip"></span><b>${escapeHTML(zone.name)}</b><span>${zone.state === 'locked' ? 'LOCKED' : zone.state === 'cleared' ? '✓ CLEAR' : 'ENTER ↗'}</span></button>`).join('');
    queryAll('.hud-zone-row').forEach((button) => button.addEventListener('click', () => travelToZone(button.dataset.hudZone)));

    // Render earned dataset fragments — train.csv is locked until Purple Zone is unlocked
    const earned = hub.datasets || [];
    const isPurpleUnlocked = !!hub.zones?.some((z) => z.id === 'purple' && z.unlocked);
    const allDatasets = [
      { key: 'train', label: 'HISTORICAL TRAINING SET (79 COLS)', file: 'train.csv', unlocked: isPurpleUnlocked },
      { key: 'community_final', label: 'YELLOW REWARD: COMMUNITY (20 COLS)', file: 'community_final.csv', unlocked: earned.includes('community_final') },
      { key: 'radio_final', label: 'BLUE REWARD: RADIO COMMS (18 COLS)', file: 'radio_final.csv', unlocked: earned.includes('radio_final') },
      { key: 'forensics_final', label: 'ORANGE REWARD: FORENSICS (18 COLS)', file: 'forensics_final.csv', unlocked: earned.includes('forensics_final') },
      { key: 'research_final', label: 'RED REWARD: RESEARCH (25 COLS)', file: 'research_final.csv', unlocked: earned.includes('research_final') }
    ];

    const unlockedCount = allDatasets.filter((d) => d.key !== 'train' && d.unlocked).length;
    if ($('#datasets-count')) $('#datasets-count').textContent = `${String(unlockedCount).padStart(2, '0')} / 04`;

    if ($('#hud-dataset-list')) {
      $('#hud-dataset-list').innerHTML = allDatasets.map((d) => {
        if (d.unlocked) {
          return `<a href="/api/dataset/${d.key}" download="${d.file}" class="hud-zone-row cleared" style="--zone:#4ade80;text-decoration:none;display:flex;align-items:center;justify-content:space-between;padding:7px 10px;margin-bottom:4px;font-size:11px;background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.25);border-radius:4px;" title="Download verified dataset fragment">
            <span style="font-weight:600;color:#f0fdf4;">◈ ${escapeHTML(d.file)}</span>
            <span style="color:#4ade80;font-weight:bold;letter-spacing:0.5px;">DOWNLOAD ⤓</span>
          </a>`;
        } else {
          return `<div class="hud-zone-row" style="opacity:0.4;display:flex;align-items:center;justify-content:space-between;padding:7px 10px;margin-bottom:4px;font-size:11px;border:1px dashed rgba(255,255,255,0.1);border-radius:4px;">
            <span style="color:#888;">◇ ${escapeHTML(d.file)}</span>
            <span style="color:#666;font-size:10px;">${d.key === 'train' ? 'LOCKED · PURPLE' : 'LOCKED'}</span>
          </div>`;
        }
      }).join('');
    }

    $('#survivor-log').innerHTML = (hub.events || []).slice(0, 5).map((event) => `<p><time>${fmtTime(event.at)}</time> ${escapeHTML(event.message)}</p>`).join('') || '<p><time>--:--</time> NETWORK INITIALIZED.</p>';
    renderMapNodes(); updateCountdown(); updateBriefingGateStatus();
  }
  function applyBootstrap(next, options = {}) {
    const previous = hub;
    previousZoneStates = previous?.zones ? previous.zones.map((zone) => ({ id: zone.id, state: zone.state, unlocked: zone.unlocked })) : null;
    const wasComplete = !!previous?.progress?.complete;
    hub = next;
    if (!hub.authenticated) return;
    updateHUD();
    if (options.animate && previousZoneStates) animateProgressChanges(previousZoneStates, hub.zones, wasComplete, !!hub.progress.complete);
  }
  function animateProgressChanges(previous, current, wasComplete = false, isComplete = false) {
    const newlyUnlocked = current.find((zone) => zone.unlocked && previous.find((old) => old.id === zone.id)?.unlocked === false);
    if (newlyUnlocked) {
      pendingUnlock = newlyUnlocked;
      if (['ctf', 'zone'].includes(document.body.dataset.screen)) {
        navigate('map', { saveView: true, force: true, instant: true }).then(() => playUnlockCinematic(newlyUnlocked));
      } else playUnlockCinematic(newlyUnlocked);
      return;
    }
    const purple = current.find((zone) => zone.id === 'purple');
    if (isComplete && !wasComplete && purple?.state === 'cleared') {
      if (document.body.dataset.screen !== 'map') navigate('map', { saveView: true, force: true, instant: true }).then(playFinale);
      else playFinale();
    }
  }
  function playUnlockCinematic(zone) {
    pendingUnlock = zone;
    const layer = $('#unlock-cinematic');
    layer.style.setProperty('--unlock-color', zone.color);
    $('#unlock-title').textContent = zone.name;
    $('#unlock-copy').textContent = `${zone.name} QUARANTINE BROKEN`;
    $('#unlock-continue').textContent = `TRAVEL TO ${zone.name} →`;
    layer.hidden = false;
    if (window.TLDScene) window.TLDScene.lurch();
  }
  function playFinale() { $('#finale-cinematic').hidden = false; if (window.TLDScene) window.TLDScene.lurch(); }
  async function refreshBootstrap(options = {}) {
    try {
      const activeTeam = hub?.team?.id || storageGet('tld_team_id');
      const fetchUrl = activeTeam ? `/api/bootstrap?team=${encodeURIComponent(activeTeam)}` : '/api/bootstrap';
      const next = await api(fetchUrl);
      if (!next.authenticated) { hub = next; setScreen('hero'); return next; }
      if (next.sessionId) storageSet('tld_session_id', next.sessionId);
      if (next.team?.id) storageSet('tld_team_id', next.team.id);
      if (next.player?.delegateId) storageSet('tld_delegate_id', next.player.delegateId);
      applyBootstrap(next, { animate: options.animate !== false });
      return next;
    } catch { return null; }
  }
  function updateCountdown() {
    if (!hub?.event) return;
    const start = Date.parse(hub.event.start), end = Date.parse(hub.event.end), now = Date.now();
    let stateText, caption, difference;
    if (!Number.isFinite(start) || !Number.isFinite(end)) { stateText = 'NOT CONFIGURED'; caption = 'EVENT SCHEDULE NOT CONFIGURED'; difference = null; }
    else if (now < start) { stateText = 'NOT STARTED'; caption = 'UNTIL EVENT OPENS'; difference = start - now; }
    else if (now < end) { stateText = 'LIVE NOW'; caption = 'TIME REMAINING'; difference = end - now; }
    else { stateText = 'EVENT ENDED'; caption = 'THE RECOVERY WINDOW IS CLOSED'; difference = null; }
    $('#timer-state').textContent = stateText; $('#event-caption').textContent = caption;
    if (difference === null) $('#event-countdown').textContent = stateText === 'EVENT ENDED' ? '00:00:00' : '--:--:--';
    else {
      const totalSeconds = Math.max(0, Math.floor(difference / 1000));
      const days = Math.floor(totalSeconds / 86400), hours = Math.floor((totalSeconds % 86400) / 3600), mins = Math.floor((totalSeconds % 3600) / 60), secs = totalSeconds % 60;
      $('#event-countdown').textContent = `${days ? `${days}D ` : ''}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    const date = new Date(); $('#map-clock').textContent = date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function typeTransmission(index) {
    const lines = ['If you\'re receiving this, the world hasn\'t finished dying.', 'We lost the archives. Then we lost the people guarding them.', 'Five zones remain. The Sanctuary is the last thing still lit.', 'Find the data. Follow the signal. Do not travel alone.'];
    const target = $('#transmission-text'); if (!target || document.body.dataset.screen !== 'hero') return;
    const line = lines[index % lines.length]; target.textContent = '';
    let i = 0;
    const tick = () => { if (document.body.dataset.screen !== 'hero') return; target.textContent = line.slice(0, i++); if (i <= line.length) setTimeout(tick, 23 + Math.random() * 32); else setTimeout(() => typeTransmission(index + 1), 5200); };
    tick();
  }
  async function handleRegistration(event) {
    event.preventDefault();
    const errorBox = $('#registration-error'); errorBox.hidden = true;
    const teamId = $('#team-id').value.trim();
    const delegateId = $('#delegate-id') ? $('#delegate-id').value.trim() : '';
    const passcode = $('#team-passcode') ? $('#team-passcode').value.trim() : '';
    if (!teamId || !delegateId || !passcode) {
      errorBox.textContent = 'TEAM ID, DELEGATE ID, AND ACCESS PASSCODE ARE ALL REQUIRED.';
      errorBox.hidden = false;
      return;
    }
    $('#scan-submit').disabled = true; $('#scan-submit .gate-label b').textContent = 'AUTHENTICATING…';
    try {
      const next = await api('/api/register', { method: 'POST', body: { teamId, delegateId, passcode } });
      hub = next;
      if (next.sessionId) storageSet('tld_session_id', next.sessionId);
      if (next.team?.id) storageSet('tld_team_id', next.team.id);
      if (next.player?.delegateId || delegateId) storageSet('tld_delegate_id', next.player?.delegateId || delegateId);
      $('#tag-team-name').textContent = next.team.name;
      $('#tag-team-id').textContent = `TEAM: ${next.team.id} | OP: ${next.player?.delegateId || delegateId}`;
      $('#dog-tag').classList.add('visible');
      $('#registration-title').innerHTML = 'IDENTITY<br><em>CONFIRMED.</em>';
      $('#scan-submit .gate-label b').textContent = 'GATE UNLOCKED';
      $('#scan-submit .gate-label small').textContent = 'SURVIVOR TAG PRINTED · WELCOME HOME';
      $('#map-network-status').textContent = 'MAHE CENTRAL DB SECURE';
      await sleep(800);
      applyBootstrap(next);
      await navigate('map', { saveView: false, instant: false });
    } catch (err) {
      errorBox.textContent = err.message || 'IDENTITY SCAN REJECTED.'; errorBox.hidden = false;
      $('#scan-submit .gate-label b').textContent = 'SCAN REJECTED · RETRY';
      if (window.TLDScene) window.TLDScene.lurch();
    } finally { $('#scan-submit').disabled = false; }
  }
  function setupMapGestures() {
    mapStage.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.zone-node, #sanctuary, button, a')) return;
      drag = { x: event.clientX, y: event.clientY, px: panX, py: panY, moved: false, id: event.pointerId };
      mapStage.setPointerCapture?.(event.pointerId);
    });
    mapStage.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        panX = Math.max(-550, Math.min(550, drag.px + dx));
        panY = Math.max(-380, Math.min(380, drag.py + dy)); updateMapTransform();
      }
    });
    mapStage.addEventListener('pointerup', () => { drag = null; });
    mapStage.addEventListener('pointercancel', () => { drag = null; });
    mapStage.addEventListener('wheel', (event) => {
      if (document.body.dataset.screen !== 'map') return;
      event.preventDefault(); zoom = Math.max(0.65, Math.min(2.2, zoom + (event.deltaY < 0 ? .08 : -.08))); updateMapTransform();
    }, { passive: false });
    const zoomInBtn = $('#map-zoom-in');
    const zoomOutBtn = $('#map-zoom-out');
    const zoomFitBtn = $('#map-zoom-fit');
    if (zoomInBtn) zoomInBtn.addEventListener('click', (e) => { e.stopPropagation(); zoom = Math.min(2.2, zoom + 0.15); updateMapTransform(); });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', (e) => { e.stopPropagation(); zoom = Math.max(0.65, zoom - 0.15); updateMapTransform(); });
    if (zoomFitBtn) zoomFitBtn.addEventListener('click', (e) => { e.stopPropagation(); zoom = 1.0; panX = 0; panY = 0; updateMapTransform(); toast('MAP VIEW RESET TO FIT ALL SECTORS'); });
    const sanctuary = $('#sanctuary');
    const openSanctuary = () => {
      const activeTeam = hub?.team?.id || storageGet('tld_team_id');
      const teamParam = activeTeam ? `?team=${encodeURIComponent(activeTeam)}` : '';
      window.open(`https://intro-stroyline.vercel.app/${teamParam}`, '_blank', 'noopener,noreferrer');
      toast('LAUNCHED INTRO STORYLINE & SANCTUARY IN NEW TAB ↗');
      updateBriefingGateStatus();
      $('#map-briefing').hidden = false;
    };
    sanctuary.addEventListener('click', openSanctuary);
    sanctuary.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSanctuary(); } });
  }
  function setupEvents() {
    $('#enter-sanctuary').addEventListener('click', async () => {
      if (hub?.authenticated) { await navigate('map', { saveView: false }); return; }
      if (window.TLDScene) window.TLDScene.lurch();
      await navigate('registration');
    });
    $('#reg-back').addEventListener('click', () => navigate('hero'));
    $('#registration-form').addEventListener('submit', handleRegistration);
    $('#hud-collapse').addEventListener('click', () => {
      const hud = $('#survivor-hud'); const collapsed = hud.classList.toggle('collapsed');
      $('#hud-collapse').textContent = collapsed ? '+' : '−'; $('#hud-collapse').setAttribute('aria-expanded', String(!collapsed)); $('#hud-expand').hidden = !collapsed;
    });
    $('#hud-expand').addEventListener('click', () => { $('#survivor-hud').classList.remove('collapsed'); $('#hud-expand').hidden = true; $('#hud-collapse').textContent = '−'; $('#hud-collapse').setAttribute('aria-expanded', 'true'); });
    $('#briefing-close').addEventListener('click', () => { $('#map-briefing').hidden = true; });
    $('#briefing-continue').addEventListener('click', () => { $('#map-briefing').hidden = true; const first = hub?.zones.find((zone) => zone.unlocked && zone.state !== 'cleared'); if (first) travelToZone(first.id); });

    // Auto-sync map with live Sanctuary CTF progression
    const checkSanctuaryStatus = async () => {
      if (!hub?.authenticated || hub?.sanctuaryCompleted) return;
      const next = await refreshBootstrap({ animate: false });
      if (next?.sanctuaryCompleted) {
        renderMapNodes();
        updateBriefingGateStatus();
        toast('SANCTUARY GATE BREACHED · YELLOW ZONE UNLOCKED!');
      }
    };
    window.addEventListener('focus', () => { refreshBootstrap({ animate: true }); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshBootstrap({ animate: true });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'ZONE_COMPLETED') {
        refreshBootstrap({ animate: true });
        toast('SECTOR PROGRESS SYNCHRONIZED · VAULT UPDATED');
      }
      if (event.data?.type === 'PURPLE_ESCAPE_QUALIFIED') {
        refreshBootstrap({ animate: true }).then((bootstrap) => {
          if (bootstrap?.ml?.escapeUnlocked || bootstrap?.zones?.find((z) => z.id === 'purple')?.state === 'cleared') {
            playFinale();
            toast('PRALAYA CORE ESCAPE GATE BREACHED! SURVIVOR COMPLETE!');
          } else {
            toast('AWAITING AUTHORITATIVE DATABASE CONFIRMATION FOR EXTRACTION...', true);
          }
        });
      }
    });
    $('#logout-button').addEventListener('click', async () => {
      try {
        await api('/api/logout', { method: 'POST', body: {} });
        hub = null;
        storageRemove('tld_session_id');
        storageRemove('tld_team_id');
        storageRemove('tld_delegate_id');
        setSound(false);
        await navigate('hero', { saveView: false, force: true });
        toast('SESSION DISCONNECTED. YOUR TEAM PROGRESS IS PRESERVED.');
      }
      catch (error) { toast(error.message || 'Could not disconnect.', true); }
    });
    $('#hud-sound').addEventListener('click', () => setSound($('#hud-sound').getAttribute('aria-pressed') !== 'true'));
    $('#hero-sound').addEventListener('click', () => setSound($('#hero-sound').getAttribute('aria-pressed') !== 'true'));
    $('#clarity-toggle').addEventListener('click', () => setClarity(document.body.dataset.clarity !== 'true'));
    $('#hud-quality').addEventListener('click', () => setQuality(document.body.dataset.quality === 'high' ? 'low' : 'high'));
    $('#map-fullscreen').addEventListener('click', toggleFullscreen);
    $('#zone-map-fullscreen').addEventListener('click', toggleFullscreen);
    $('#hud-fullscreen').addEventListener('click', toggleFullscreen);
    $('#zone-back').addEventListener('click', () => navigate('map'));
    $('#ctf-back').addEventListener('click', backToMap);
    $('#ctf-retry').addEventListener('click', () => { if (activeCtf) loadIframe(new URL(activeCtf.url, location.href).href); else showSignalLost(); });
    $('#unlock-continue').addEventListener('click', async () => {
      const zone = pendingUnlock; $('#unlock-cinematic').hidden = true;
      if (zone) await travelToZone(zone.id);
    });
    $('#finale-continue').addEventListener('click', async () => { $('#finale-cinematic').hidden = true; await navigate('map', { saveView: true, force: true }); toast('SURVIVOR COMPLETE · ALL DATASETS RECOVERED.'); });
    $('#mobile-notice').addEventListener('click', () => toast('TIP: USE THE FIELD HUD TO OPEN AVAILABLE ZONES. LOCKED ZONES CANNOT BE SKIPPED.'));
    document.addEventListener('fullscreenchange', () => { const value = !!document.fullscreenElement; $('#map-fullscreen').setAttribute('aria-pressed', String(value)); });
    window.addEventListener('message', async (event) => {
      // postMessage is only a cue to ask the server for truth; it never mutates client-side progress.
      if (!expectedCtfOrigin || event.origin !== expectedCtfOrigin || !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'TLD_CTF_SOLVED') {
        const before = hub?.progress?.solved || 0;
        const next = await refreshBootstrap({ animate: true });
        if (next && next.progress.solved === before) toast('COMPLETION SIGNAL RECEIVED. WAITING FOR SERVER-VERIFIED PROGRESS.', true);
        if (event.data.returnToMap === true) await backToMap();
      } else if (event.data.type === 'TLD_CTF_RETURN_TO_MAP') await backToMap();
    });
  }
  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast('FULLSCREEN IS NOT AVAILABLE IN THIS BROWSER.', true); }
  }
  async function boot() {
    const clarity = storageGet('tld-clarity') === 'true';
    const quality = storageGet('tld-quality') === 'low' ? 'low' : 'high';
    setClarity(clarity); setQuality(quality); setSound(false);
    setupEvents(); setupMapGestures();
    setTimeout(() => $('#boot-mask').classList.add('boot-hide'), reducedMotion ? 40 : 900);
    setInterval(updateCountdown, 1000);
    setInterval(async () => {
      if (hub?.authenticated && !transitionBusy) {
        await refreshBootstrap({ animate: false });
      }
    }, 3000);
    setInterval(() => {
      const title = $('#hero-title'); if (!title || document.body.dataset.screen !== 'hero' || document.body.dataset.clarity === 'true') return;
      title.classList.add('glitch'); setTimeout(() => title.classList.remove('glitch'), 600);
    }, 6300);
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTeam = (urlParams.get('team') || urlParams.get('teamId') || '').trim();
      if (queryTeam) storageSet('tld_team_id', queryTeam);
      const activeTeam = queryTeam || storageGet('tld_team_id');
      const bootUrl = activeTeam ? `/api/bootstrap?team=${encodeURIComponent(activeTeam)}` : '/api/bootstrap';

      const data = await api(bootUrl);
      if (data.authenticated) {
        if (data.sessionId) storageSet('tld_session_id', data.sessionId);
        if (data.team?.id) storageSet('tld_team_id', data.team.id);
        if (data.player?.delegateId) storageSet('tld_delegate_id', data.player.delegateId);
        applyBootstrap(data);
        if (data.view?.screen === 'zone' && data.view.zoneId) await showZone(data.view.zoneId, { saveView: false, instant: true });
        else if (data.view?.screen === 'ctf' && data.view.ctfId) await openCtf(data.view.ctfId, { instant: true });
        else { setScreen('map'); }
        renderMapNodes();
      } else {
        hub = data;
        if (location.hash === '#registration') await navigate('registration', { instant: true });
        else if (location.hash === '#map') { setScreen('map'); updateHUD(); }
        else setScreen('hero');
        renderMapNodes();
      }
    } catch (error) {
      setScreen('hero'); toast('LOCAL SIGNAL IS NOT REACHABLE. START THE HUB SERVER AND RETRY.', true);
    }
    typeTransmission(0);
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#map-briefing').hidden) $('#map-briefing').hidden = true;
      if (!$('#unlock-cinematic').hidden) $('#unlock-cinematic').hidden = true;
      if (!$('#finale-cinematic').hidden) $('#finale-cinematic').hidden = true;
    }
  });
  boot();
})();
