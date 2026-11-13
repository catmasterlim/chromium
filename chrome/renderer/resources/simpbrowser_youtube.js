// Copyright 2026 The SimpBrowser Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Runs at document start in the page's ordinary world: no browser privileges,
// extension APIs, remote scripts, cookies, or external filter downloads.
(() => {
  'use strict';
  const host = location.hostname;
  if (location.protocol !== 'https:' ||
      !['youtube.com', 'youtube-nocookie.com'].some(
          domain => host === domain || host.endsWith('.' + domain))) return;
  const key = Symbol.for('simpbrowser.youtube.v1');
  if (window[key]) return;

  const storageKey = 'simpbrowser.youtube.settings.v1';
  const qualities = [
    ['auto', '자동', 0], ['tiny', '144p', 144],
    ['small', '240p', 240], ['medium', '360p', 360],
    ['large', '480p', 480], ['hd720', '720p', 720],
    ['hd1080', '1080p', 1080], ['hd1440', '1440p', 1440],
    ['hd2160', '2160p (4K)', 2160], ['hd2880', '2880p', 2880],
    ['highres', '최고 화질', 4320],
  ];
  const heights = new Map(qualities.map(([id, , height]) => [id, height]));
  let settings = { quality: 'hd1080', ads: true, showControls: false, diagnostics: true };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && heights.has(saved.quality)) settings.quality = saved.quality;
    if (saved && typeof saved.ads === 'boolean') settings.ads = saved.ads;
    if (saved && typeof saved.showControls === 'boolean') {
      settings.showControls = saved.showControls;
    }
    if (saved && typeof saved.diagnostics === 'boolean') settings.diagnostics = saved.diagnostics;
  } catch {}  // Storage can be unavailable in third-party/private frames.
  const stats = { blockedRequests: 0, nativeBlockedRequests: 0,
    cleanedResponses: 0, skippedAds: 0, observedAdResources: 0,
    playbackErrors: 0, responseParseErrors: 0 };
  const diagnosticKey = 'simpbrowser.youtube.diagnostics.v1';
  const eventTypes = new Set(['request_blocked', 'native_blocked', 'response_cleaned',
    'response_parse_error', 'ad_started', 'ad_ended', 'ad_still_active',
    'ad_skipped', 'media_error', 'media_stalled', 'ad_resource_observed', 'ad_image_hidden']);
  const transports = new Set(['fetch', 'xhr', 'beacon', 'img', 'script', 'iframe',
    'link', 'css', 'other', 'button', 'seek']);
  const events = [];
  const lastEvents = new Map();
  let flushPending = false;
  let lastNativeCount = 0;
  let wasAd = false;
  let adStartedAt = 0;
  function persistDiagnostics() {
    if (!settings.diagnostics) return;
    try { sessionStorage.setItem(diagnosticKey, JSON.stringify({ events })); } catch {}
  }
  // Only fixed event names and bounded numbers survive a reload. No URLs,
  // request bodies, video IDs, page titles, cookies, or response text are stored.
  try {
    if (settings.diagnostics) {
      const saved = JSON.parse(sessionStorage.getItem(diagnosticKey));
      for (const event of (Array.isArray(saved?.events) ? saved.events : []).slice(-128)) {
        if (!eventTypes.has(event?.type) || !Number.isFinite(event.at)) continue;
        events.push({ type: event.type, at: event.at,
          count: Math.max(0, Math.min(1000000, Number(event.count) || 0)),
          code: Math.max(0, Math.min(4, Number(event.code) || 0)),
          transport: transports.has(event.transport) ? event.transport : 'other' });
      }
    } else { sessionStorage.removeItem(diagnosticKey); }
  } catch {}
  function record(type, count = 1, transport = 'other', code = 0) {
    if (!settings.diagnostics || !eventTypes.has(type)) return;
    const at = Date.now();
    if (!Number.isFinite(at)) return;
    const eventKey = type + ':' + transport;
    const interval = type === 'ad_still_active' ? 10000 : 1000;
    if (at - (lastEvents.get(eventKey) || 0) < interval) return;
    lastEvents.set(eventKey, at);
    events.push({ type, at, count: Math.min(1000000, Math.max(0, count)),
      transport: transports.has(transport) ? transport : 'other',
      code: Math.max(0, Math.min(4, Number(code) || 0)) });
    if (events.length > 128) events.shift();
    if (!flushPending) {
      flushPending = true;
      setTimeout(() => {
        flushPending = false;
        persistDiagnostics();
      }, 1000);
    }
  }
  function diagnostics() {
    return { version: 1, scope: 'youtube-ad-diagnostics', enabled: settings.diagnostics,
      settings: { ads: settings.ads, quality: settings.quality },
      counters: { ...stats }, events: events.map(event => ({ ...event })) };
  }
  function clearDiagnostics() {
    events.length = 0;
    lastEvents.clear();
    try { sessionStorage.removeItem(diagnosticKey); } catch {}
  }
  function syncPolicy() {
    const root = document.documentElement;
    if (!root) return;
    const policy = settings.ads ? 'on' : 'off';
    if (root.getAttribute('data-simpbrowser-ad-policy') !== policy) {
      root.setAttribute('data-simpbrowser-ad-policy', policy);
    }
    const count = Math.min(1000000, Math.max(0,
        Number(root.getAttribute('data-simpbrowser-native-blocks')) || 0));
    if (count > lastNativeCount) {
      stats.nativeBlockedRequests += count - lastNativeCount;
      record('native_blocked', count - lastNativeCount);
    }
    lastNativeCount = count;
  }
  let selectedQuality = '';
  let currentQuality = '';
  let playerReference;
  let lastQualityAttempt = -Infinity;
  let lastAdAction = 0;
  let scheduled = false;
  let ui;
  let sheet;
  const status = () => ({ version: 2, ...settings, selectedQuality,
    currentQuality, ...stats });
  Object.defineProperty(window, key, {
    value: Object.freeze({ getStatus: status, getDiagnostics: diagnostics }), configurable: false,
  });
  syncPolicy();

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch {}
  }
  function asUrl(value) {
    try { return new URL(value instanceof Request ? value.url : value, location.href); }
    catch { return null; }
  }
  function isPlayerUrl(value) {
    const url = asUrl(value);
    return url && url.protocol === 'https:' &&
        (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com') ||
         url.hostname === 'youtube-nocookie.com' ||
         url.hostname.endsWith('.youtube-nocookie.com')) &&
        /^\/youtubei\/v1\/player\/?$/.test(url.pathname);
  }
  function isAdUrl(value) {
    const url = asUrl(value);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    if (['doubleclick.net', 'googlesyndication.com', 'googleadservices.com'].some(
        domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
      return true;
    }
    return (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) &&
        /^\/(?:pagead\/|api\/stats\/ads(?:\/|$))/.test(url.pathname);
  }
  function cleanPlayer(value, depth = 0) {
    if (!settings.ads || !value || typeof value !== 'object') return value;
    let removed = false;
    for (const name of ['adPlacements', 'playerAds', 'adSlots']) {
      if (Object.hasOwn(value, name)) {
        try { removed = delete value[name] || removed; } catch {}
      }
    }
    if (removed) {
      stats.cleanedResponses++;
      record('response_cleaned');
    }
    // Sanitize known player-response envelopes, not arbitrary similarly named
    // fields in unrelated application data. Bound depth and avoid cycles.
    if (depth < 2) {
      for (const name of ['playerResponse', 'player_response']) {
        if (value[name] && value[name] !== value && typeof value[name] === 'object') {
          cleanPlayer(value[name], depth + 1);
        }
      }
    }
    return value;
  }
  function cleanText(text) {
    if (typeof text !== 'string') return text;
    const prefix = text.startsWith(")]}'") ? text.slice(0, text.indexOf('\n') + 1) : '';
    try {
      const value = JSON.parse(text.slice(prefix.length));
      const before = stats.cleanedResponses;
      cleanPlayer(value);
      return before === stats.cleanedResponses ? text : prefix + JSON.stringify(value);
    } catch {
      stats.responseParseErrors++;
      record('response_parse_error');
      return text;
    }
  }

  // The initial player response is assigned by YouTube's inline bootstrap.
  const initialName = 'ytInitialPlayerResponse';
  try {
    let initial = cleanPlayer(window[initialName]);
    const descriptor = Object.getOwnPropertyDescriptor(window, initialName);
    if (!descriptor || (descriptor.configurable && !descriptor.get && !descriptor.set)) {
      Object.defineProperty(window, initialName, {
        configurable: true, enumerable: true,
        get: () => initial,
        set: value => { initial = cleanPlayer(value); },
      });
    }
  } catch {}

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function(input, init) {
      if (!settings.ads) return Reflect.apply(nativeFetch, this, arguments);
      if (isAdUrl(input)) {
        const signal = init?.signal || (input instanceof Request ? input.signal : null);
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        stats.blockedRequests++;
        record('request_blocked', 1, 'fetch');
        return new Response(null, { status: 204, statusText: 'No Content' });
      }
      const response = await Reflect.apply(nativeFetch, this, arguments);
      if (!isPlayerUrl(input) || !response.ok) return response;
      try {
        const original = await response.clone().text();
        const cleaned = cleanText(original);
        if (cleaned === original) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const result = new Response(cleaned, {
          status: response.status, statusText: response.statusText, headers,
        });
        for (const name of ['url', 'redirected', 'type']) {
          Object.defineProperty(result, name, { value: response[name] });
        }
        return result;
      } catch { return response; }
    };
  }

  // Preserve native XHR events and synchronous/asynchronous behavior. Blocked
  // advertising requests resolve locally to {} instead of contacting a server.
  const xhr = XMLHttpRequest.prototype;
  const nativeOpen = xhr.open;
  xhr.open = function(method, url, ...rest) {
    if (settings.ads && isAdUrl(url)) {
      stats.blockedRequests++;
      record('request_blocked', 1, 'xhr');
      return nativeOpen.call(this, 'GET', 'data:application/json,%7B%7D',
          rest.length ? rest[0] : true);
    }
    return nativeOpen.call(this, method, url, ...rest);
  };
  const nativeBeacon = navigator.sendBeacon;
  if (typeof nativeBeacon === 'function') {
    navigator.sendBeacon = function(url, data) {
      if (settings.ads && isAdUrl(url)) {
        stats.blockedRequests++;
        record('request_blocked', 1, 'beacon');
        return true;
      }
      return Reflect.apply(nativeBeacon, this, arguments);
    };
  }
  for (const name of ['response', 'responseText']) {
    const descriptor = Object.getOwnPropertyDescriptor(xhr, name);
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(xhr, name, {
      ...descriptor,
      get() {
        const value = descriptor.get.call(this);
        if (!settings.ads || this.readyState !== 4 || !isPlayerUrl(this.responseURL)) {
          return value;
        }
        return typeof value === 'string' ? cleanText(value) : cleanPlayer(value);
      },
    });
  }

  const adCss = `
    ytd-ad-slot-renderer, ytd-display-ad-renderer,
    ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer,
    ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer,
    #masthead-ad, #player-ads, .ytp-ad-overlay-container,
    .ytp-ad-text-overlay, .ytp-ad-image-overlay { display: none !important; }
  `;
  function installStyle() {
    if (!settings.ads || sheet) return;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(adCss);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch { sheet = null; }
  }
  function desiredQuality(levels) {
    const available = levels.filter(id => heights.has(id) && id !== 'auto')
        .sort((a, b) => heights.get(b) - heights.get(a));
    if (!available.length) return '';
    return available.find(id => heights.get(id) <= heights.get(settings.quality)) ||
        available[available.length - 1];
  }
  function enforceQuality(player) {
    if (playerReference !== player) {
      playerReference = player;
      lastQualityAttempt = -Infinity;
    }
    try { currentQuality = player?.getPlaybackQuality?.() || ''; } catch {}
    if (settings.quality === 'auto') { selectedQuality = 'auto'; return; }
    if (typeof player?.getAvailableQualityLevels !== 'function') return;
    try {
      const levels = player.getAvailableQualityLevels();
      if (!Array.isArray(levels)) return;
      selectedQuality = desiredQuality(levels);
      if (!selectedQuality || currentQuality === selectedQuality ||
          performance.now() - lastQualityAttempt < 3000) return;
      lastQualityAttempt = performance.now();
      player.setPlaybackQualityRange?.(selectedQuality, selectedQuality);
      player.setPlaybackQuality?.(selectedQuality);
    } catch {}  // Player APIs are site internals and can change independently.
  }
  function skipAd(player) {
    if (!settings.ads || !player ||
        !(player.classList.contains('ad-showing') ||
          player.classList.contains('ad-interrupting')) ||
        performance.now() - lastAdAction < 750) return;
    const skip = player.querySelector(
        '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button');
    if (skip && !skip.disabled && skip.getClientRects().length) {
      lastAdAction = performance.now();
      skip.click();
      stats.skippedAds++;
      record('ad_skipped', 1, 'button');
      return;
    }
    const video = player.querySelector('video');
    // Only seek a finite, positively identified ad, never an ordinary/live video.
    if (video && !video.seeking && Number.isFinite(video.duration) &&
        video.duration > 0 && video.duration < 600 &&
        video.currentTime < video.duration - 0.1) {
      try {
        lastAdAction = performance.now();
        video.currentTime = video.duration;
        stats.skippedAds++;
        record('ad_skipped', 1, 'seek');
      } catch {}
    }
  }

  function mountUi() {
    if (!document.body || window !== window.top) return;
    if (ui) {
      if (!ui.host.isConnected) document.body.append(ui.host);
      return;
    }
    const host = document.createElement('div');
    host.id = 'simpbrowser-youtube-settings';
    host.hidden = !settings.showControls;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host([hidden]) { display:none !important; }
      :host { position:fixed; right:18px; bottom:88px; z-index:2147483646;
        font:13px/1.5 system-ui,sans-serif; color:#f1f5f9; color-scheme:dark; }
      button,select,input { font:inherit; } button,select { cursor:pointer; }
      button { padding:8px 12px; background:#172432; color:inherit;
        border:1px solid #426579; border-radius:10px; }
      section { width:344px; max-width:calc(100vw - 36px);
        max-height:calc(100vh - 180px); overflow-y:auto;
        box-sizing:border-box; padding:16px; margin-bottom:8px; background:#14202c;
        border:1px solid #426579; border-radius:14px; box-shadow:0 8px 30px #0007; }
      [hidden] { display:none; } h2 { font-size:16px; margin:0 0 14px; }
      label { display:block; margin:12px 0; } select { width:100%; margin-top:6px;
        padding:7px; background:#24384a; color:inherit; border:1px solid #527288;
        border-radius:6px; } p { color:#bccbd6; margin:10px 0 0; font-size:12px; }
      input { accent-color:#74d3c8; } :focus-visible { outline:2px solid #74d3c8; }
      summary { cursor:pointer; font-weight:600; padding:8px 0; }
      dl { display:grid; grid-template-columns:1fr auto; gap:6px 14px; margin:10px 0; }
      dt { color:#bccbd6; } dd { margin:0; font-variant-numeric:tabular-nums;
        color:#8fe3d8; font-weight:600; }
      ol { padding-left:18px; font-size:12px; color:#bccbd6; overflow-wrap:anywhere; }
      li { margin:7px 0; } .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
    `;
    const section = document.createElement('section');
    section.hidden = true;
    section.id = 'preferences';
    section.setAttribute('aria-label', 'SimpBrowser 유튜브 설정');
    const heading = document.createElement('h2');
    heading.textContent = 'SimpBrowser · 유튜브';
    heading.tabIndex = -1;
    const statistics = document.createElement('details');
    statistics.open = true;
    statistics.id = 'statistics';
    const summary = document.createElement('summary');
    summary.textContent = '광고 차단 · 진단 통계';
    const statisticsNote = document.createElement('p');
    statisticsNote.textContent = '새로고침 전까지 누적한 수치입니다. 진단 기록은 이 탭의 최근 128건입니다.';
    const values = document.createElement('dl');
    const statisticNodes = new Map();
    for (const [id, text] of [
      ['total', '차단한 요청 합계'], ['blockedRequests', '페이지 요청 차단'],
      ['nativeBlockedRequests', '렌더러 요청 차단'],
      ['cleanedResponses', '광고 데이터 처리'], ['skippedAds', '광고 건너뛰기 시도'],
      ['observedAdResources', '광고 리소스 관찰'], ['playbackErrors', '영상 재생 오류'],
      ['responseParseErrors', '응답 해석 오류'], ['records', '진단 기록'],
    ]) {
      const term = document.createElement('dt');
      term.textContent = text;
      if (id === 'observedAdResources') {
        term.title = '관찰 건수는 광고 노출이나 차단 실패 건수가 아닙니다.';
      }
      const value = document.createElement('dd');
      value.dataset.stat = id;
      values.append(term, value);
      statisticNodes.set(id, value);
    }
    const resetStatistics = document.createElement('button');
    resetStatistics.id = 'reset-statistics';
    resetStatistics.type = 'button';
    resetStatistics.textContent = '페이지 수치 초기화';
    resetStatistics.addEventListener('click', () => {
      for (const name of Object.keys(stats)) stats[name] = 0;
      lastNativeCount = 0;
      document.documentElement?.setAttribute('data-simpbrowser-native-blocks', '0');
      tick();
    });
    statistics.append(summary, statisticsNote, values, resetStatistics);
    const label = document.createElement('label');
    label.textContent = '고정 화질';
    const select = document.createElement('select');
    select.setAttribute('aria-label', '고정 화질');
    for (const [id, text] of qualities) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = text;
      select.append(option);
    }
    select.value = settings.quality;
    select.addEventListener('change', () => {
      if (!heights.has(select.value)) return;
      settings.quality = select.value;
      selectedQuality = '';
      lastQualityAttempt = -Infinity;
      save();
      // Release a previously fixed range when the user selects automatic mode.
      if (settings.quality === 'auto') {
        try { playerReference?.setPlaybackQualityRange?.('auto', 'auto');
          playerReference?.setPlaybackQuality?.('auto'); } catch {}
      }
      tick();
    });
    label.append(select);
    const adsLabel = document.createElement('label');
    const ads = document.createElement('input');
    ads.type = 'checkbox';
    ads.checked = settings.ads;
    ads.setAttribute('aria-label', '광고 제거');
    adsLabel.append(ads, document.createTextNode(' 광고 제거 (변경 시 새로고침)'));
    ads.addEventListener('change', () => {
      settings.ads = ads.checked;
      save();
      syncPolicy();
      location.reload();
    });
    const note = document.createElement('p');
    note.textContent = '선택 화질이 없으면 가능한 하위 화질을 사용합니다. 설정은 이 사이트에 저장됩니다.';
    const state = document.createElement('p');
    state.setAttribute('aria-live', 'polite');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'preferences');
    button.addEventListener('click', () => {
      section.hidden = !section.hidden;
      button.setAttribute('aria-expanded', String(!section.hidden));
      if (!section.hidden) {
        section.scrollTop = 0;
        heading.focus({ preventScroll: true });
        tick();
      }
    });
    shadow.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        section.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      }
    });
    const diagnosticLabel = document.createElement('label');
    const diagnosticToggle = document.createElement('input');
    diagnosticToggle.type = 'checkbox';
    diagnosticToggle.setAttribute('aria-label', '로컬 진단 기록');
    diagnosticToggle.checked = settings.diagnostics;
    diagnosticLabel.append(diagnosticToggle, document.createTextNode(' 로컬 진단 기록'));
    diagnosticToggle.addEventListener('change', () => {
      settings.diagnostics = diagnosticToggle.checked;
      save();
      if (!settings.diagnostics) {
        clearDiagnostics();
      }
      tick();
    });
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = '진단 JSON 저장';
    exportButton.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics(), null, 2)],
          { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'simpbrowser-youtube-diagnostics.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const diagnosticNote = document.createElement('p');
    diagnosticNote.textContent = '현재 탭에 최대 128건만 저장합니다. 주소·검색어·쿠키를 기록하거나 외부로 전송하지 않습니다.';
    const recent = document.createElement('details');
    const recentSummary = document.createElement('summary');
    recentSummary.textContent = '최근 진단 이벤트';
    const recentList = document.createElement('ol');
    recentList.id = 'diagnostic-events';
    const recentEmpty = document.createElement('p');
    recent.append(recentSummary, recentEmpty, recentList);
    const clearRecords = document.createElement('button');
    clearRecords.id = 'clear-diagnostics';
    clearRecords.type = 'button';
    clearRecords.textContent = '진단 기록 삭제';
    clearRecords.addEventListener('click', () => { clearDiagnostics(); tick(); });
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(exportButton, clearRecords);
    section.append(heading, statistics, label, adsLabel, note, state,
        diagnosticLabel, recent, actions, diagnosticNote);
    shadow.append(style, section, button);
    document.body.append(host);
    ui = { host, button, section, state, statisticNodes, recentList, recentEmpty,
      recentSignature: '' };
  }
  function renderStatistics() {
    for (const [id, node] of ui.statisticNodes) {
      const text = id === 'total' ? String(stats.blockedRequests + stats.nativeBlockedRequests) :
          id === 'records' ? `${settings.diagnostics ? '기록 중' : '꺼짐'} · ${events.length} / 128` :
          String(stats[id]);
      if (node.textContent !== text) node.textContent = text;
    }
    const signature = settings.diagnostics + ':' + JSON.stringify(events.slice(-6));
    if (signature === ui.recentSignature) return;
    ui.recentSignature = signature;
    ui.recentList.replaceChildren();
    ui.recentEmpty.textContent = !settings.diagnostics ? '진단 기록이 꺼져 있습니다.' :
        events.length ? '최근 6건 · 전체 기록은 JSON으로 저장할 수 있습니다.' : '기록된 이벤트가 없습니다.';
    const labels = {
      request_blocked: '페이지 광고 요청 차단', native_blocked: '렌더러 광고 요청 차단',
      response_cleaned: '광고 데이터 처리', response_parse_error: '플레이어 응답 해석 오류',
      ad_started: '광고 재생 감지', ad_ended: '광고 상태 종료', ad_still_active: '광고 상태 지속',
      ad_skipped: '광고 건너뛰기 시도', media_error: '영상 재생 오류',
      media_stalled: '영상 데이터 대기', ad_resource_observed: '광고 리소스 관찰',
      ad_image_hidden: '광고 이미지 표시 제거',
    };
    for (const event of events.slice(-6).reverse()) {
      const item = document.createElement('li');
      const time = new Date(event.at).toLocaleTimeString('ko-KR', { hour12: false });
      item.textContent = `${time} · ${labels[event.type] || '진단 이벤트'}` +
          (event.transport !== 'other' ? ` · ${event.transport}` : '') +
          (event.code ? ` · 오류 코드 ${event.code}` : '');
      ui.recentList.append(item);
    }
  }
  function tick() {
    scheduled = false;
    syncPolicy();
    installStyle();
    mountUi();
    const player = document.querySelector('#movie_player, #player-container .html5-video-player');
    if (player) {
      const ad = player.classList.contains('ad-showing') ||
          player.classList.contains('ad-interrupting');
      if (ad !== wasAd) {
        wasAd = ad;
        adStartedAt = ad ? Date.now() : 0;
        record(ad ? 'ad_started' : 'ad_ended');
      }
      if (ad && Date.now() - adStartedAt > 10000) record('ad_still_active');
      skipAd(player);
      if (!player.classList.contains('ad-showing') &&
          !player.classList.contains('ad-interrupting')) enforceQuality(player);
    }
    if (ui) {
      const label = qualities.find(([id]) => id === settings.quality)?.[1] || '1080p';
      const text = 'SimpBrowser · ' + label;
      if (ui.button.textContent !== text) ui.button.textContent = text;
      if (!ui.host.hidden && !ui.section.hidden) {
        renderStatistics();
        const active = qualities.find(([id]) => id === currentQuality)?.[1] || '플레이어 대기 중';
        const text = `현재 ${active} · 광고 요청 차단 ${stats.blockedRequests + stats.nativeBlockedRequests}건`;
        if (ui.state.textContent !== text) ui.state.textContent = text;
      }
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(tick, 100);
  }
  new MutationObserver(schedule).observe(document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
  });
  document.addEventListener('yt-navigate-finish', () => {
    lastQualityAttempt = -Infinity;
    selectedQuality = '';
    schedule();
  });
  document.addEventListener('loadedmetadata', schedule, true);
  window.addEventListener('pagehide', persistDiagnostics);
  document.addEventListener('error', event => {
    if (settings.ads && event.target instanceof HTMLImageElement &&
        (isAdUrl(event.target.currentSrc) || isAdUrl(event.target.src))) {
      event.target.hidden = true;
      event.target.style.setProperty('display', 'none', 'important');
      record('ad_image_hidden', 1, 'img');
    }
    if (event.target instanceof HTMLMediaElement) {
      stats.playbackErrors++;
      record('media_error', 1, 'other', event.target.error?.code || 0);
    }
  }, true);
  document.addEventListener('stalled', event => {
    if (event.target instanceof HTMLMediaElement) record('media_stalled');
  }, true);
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (isAdUrl(entry.name)) {
          stats.observedAdResources++;
          record('ad_resource_observed', 1, entry.initiatorType);
        }
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}
  document.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
        event.code === 'KeyY' && !event.repeat) {
      settings.showControls = !settings.showControls;
      save();
      mountUi();
      if (ui) ui.host.hidden = !settings.showControls;
      event.preventDefault();
    }
  });
  document.addEventListener('visibilitychange', schedule);
  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  setInterval(tick, 1000);
  schedule();
})();
