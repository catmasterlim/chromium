import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const injected = process.argv.includes('--inject-script');
const live = process.argv.includes('--live');
const directory = path.join(root, 'simpbrowser/test-results', injected ? 'youtube-injected' : 'youtube-native');
const profile = path.join(directory, `profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const result = { startedAt: new Date().toISOString(), injected, checks: [] };
let socket;
let stderr = '';
const browser = spawn(path.join(root, 'out/SimpBrowser/chrome.exe'), [
  '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let spawnError;
browser.on('error', error => { spawnError = error; });
browser.stderr.on('data', data => { stderr += data; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><meta charset="utf-8"><title>YouTube feature fixture</title>
<script>
window.beforePage = !!window[Symbol.for('simpbrowser.youtube.v1')];
window.ytInitialPlayerResponse = {videoDetails:{videoId:'fixture'},
  streamingData:{formats:[{itag:22}]},playerAds:[{ad:1}],adSlots:[{ad:1}],adPlacements:[{ad:1}]};
window.levels=['hd2160','hd1440','hd1080','hd720','medium'];
window.actualQuality='hd720'; window.qualityCalls=[]; window.seekCalls=[]; window.skipClicks=0;
</script><ytd-ad-slot-renderer>Sponsored</ytd-ad-slot-renderer><div id="normal">Normal content</div>
<div id="movie_player" class="html5-video-player"><video></video></div>
<script>
const player=document.querySelector('#movie_player');
player.getAvailableQualityLevels=()=>window.levels;
player.getPlaybackQuality=()=>window.actualQuality;
player.setPlaybackQualityRange=(a,b)=>{window.qualityCalls.push([a,b]);window.actualQuality=a};
player.setPlaybackQuality=q=>{window.actualQuality=q};
const video=player.querySelector('video');
window.testDuration=120; window.testTime=10;
Object.defineProperty(video,'duration',{get:()=>window.testDuration});
Object.defineProperty(video,'seeking',{get:()=>false});
Object.defineProperty(video,'currentTime',{get:()=>window.testTime,set:t=>{window.testTime=t;window.seekCalls.push(t)}});
</script>`;
const playerResponse = { videoDetails: { videoId: 'fixture' },
  streamingData: { formats: [{ itag: 22 }] }, playerAds: [{ ad: 1 }],
  adPlacements: [{ ad: 1 }], adSlots: [{ ad: 1 }] };
try {
  let port;
  for (let i = 0; i < 120; i++) {
    if (spawnError) throw spawnError;
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`);
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await sleep(500); }
  }
  assert.ok(port, 'Browser debugging endpoint did not start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  let handleEvent = () => {};
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id) { handleEvent(message); return; }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timeout);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const data = await call('Runtime.evaluate', { expression, returnByValue: true,
      awaitPromise: true, userGesture: true });
    if (data.exceptionDetails) throw new Error(JSON.stringify(data.exceptionDetails));
    return data.result.value;
  };
  const waitFor = async (expression, description, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await evaluate(expression)) return; } catch {}
      await sleep(200);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const passed = (name, details) => { result.checks.push({ name, passed: true, details }); console.log(`PASS ${name}`); };
  let interceptedAds = 0;
  const networkErrors = [];
  handleEvent = message => {
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const url = new URL(request.url);
    const ad = /doubleclick|googlesyndication|googleadservices/.test(url.hostname);
    if (ad) interceptedAds++;
    const player = url.pathname === '/youtubei/v1/player';
    const data = url.searchParams.get('fixture') === 'wrapped' ?
      { playerResponse, unrelated: { adSlots: ['not-player-data'] } } : playerResponse;
    const body = player ? JSON.stringify(data) : ad ? '{}' : fixture;
    call('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: player || ad ? 'application/json' : 'text/html; charset=utf-8' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
      ],
      body: Buffer.from(body).toString('base64'),
    }).catch(error => networkErrors.push(String(error)));
  };
  await call('Page.enable');
  if (injected) {
    const script = await readFile(path.join(root, 'chrome/renderer/resources/simpbrowser_youtube.js'), 'utf8');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: script });
  }
  await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const fixtureUrl = 'https://www.youtube.com/__simpbrowser_test';
  const navigate = async url => {
    await call('Page.navigate', { url });
    await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && document.title === 'YouTube feature fixture'`, 'fixture navigation');
  };
  const status = `window[Symbol.for('simpbrowser.youtube.v1')]?.getStatus()`;
  await navigate(fixtureUrl);
  assert.equal(await evaluate('window.beforePage'), true);
  passed('installed-before-page-scripts');
  await waitFor('window.actualQuality === "hd1080"', '1080p default');
  const initial = await evaluate('window.ytInitialPlayerResponse');
  assert.equal(initial.videoDetails.videoId, 'fixture');
  assert.ok(initial.streamingData.formats.length);
  for (const key of ['playerAds', 'adSlots', 'adPlacements']) assert.ok(!(key in initial));
  passed('initial-ad-data-removed-with-media-preserved');
  assert.equal(await evaluate('window.testTime'), 10);
  assert.equal(await evaluate('document.querySelector("video").playbackRate'), 1);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("ytd-ad-slot-renderer")).display'), 'none');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("#normal")).display'), 'none');
  passed('1080p-default-and-normal-video-unchanged');
  const fetched = await evaluate(`fetch('/youtubei/v1/player?fixture=fetch').then(r=>r.json())`);
  assert.equal(fetched.videoDetails.videoId, 'fixture');
  assert.ok(!('playerAds' in fetched) && !('adSlots' in fetched) && !('adPlacements' in fetched));
  passed('fetch-player-response-sanitized');
  const wrapped = await evaluate(`fetch('/youtubei/v1/player?fixture=wrapped').then(r=>r.json())`);
  assert.ok(!('playerAds' in wrapped.playerResponse));
  assert.deepEqual(wrapped.unrelated.adSlots, ['not-player-data']);
  passed('wrapped-player-response-cleaned-with-unrelated-data-preserved');
  for (const responseType of ['', 'json']) {
    const value = await evaluate(`new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/youtubei/v1/player?fixture=xhr');x.responseType=${JSON.stringify(responseType)};x.onload=()=>resolve(x.responseType==='json'?x.response:JSON.parse(x.responseText));x.onerror=()=>reject(Error('XHR failed'));x.send()})`);
    assert.equal(value.videoDetails.videoId, 'fixture');
    assert.ok(!('playerAds' in value) && !('adSlots' in value));
  }
  passed('xhr-text-and-json-player-responses-sanitized');
  assert.equal(await evaluate(`fetch('https://googleads.g.doubleclick.net/pagead/adview').then(r=>r.status)`), 204);
  await evaluate(`new Promise(resolve=>{const x=new XMLHttpRequest();x.open('POST','https://googleads.g.doubleclick.net/pagead/adview');x.onloadend=()=>resolve(x.status);x.send('ad')})`);
  assert.equal(interceptedAds, 0);
  passed('fetch-and-xhr-ad-requests-never-reach-network');
  assert.equal(await evaluate(`navigator.sendBeacon('https://googleads.g.doubleclick.net/pagead/adview?token=private-token', 'private-body')`), true);
  assert.equal(interceptedAds, 0);
  passed('ad-beacons-blocked-before-network');
  if (!injected) {
    await evaluate(`new Promise(resolve=>{const image=new Image();image.onload=image.onerror=()=>resolve();image.src='https://googleads.g.doubleclick.net/pagead/native-image';document.body.append(image)})`);
    await evaluate(`new Promise(resolve=>{const script=document.createElement('script');script.onload=script.onerror=()=>resolve();script.src='https://googleads.g.doubleclick.net/pagead/native-script';document.head.append(script)})`);
    assert.equal(interceptedAds, 0);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('img[src$="/native-image"]')).display`), 'none');
    await waitFor(`${status}.nativeBlockedRequests >= 2`, 'native request counters');
    passed('native-ad-image-and-script-requests-blocked');
  }
  assert.equal(await evaluate(`fetch('https://r1.googlevideo.com/videoplayback?fixture=1').then(r=>r.status)`), 200);
  assert.equal(await evaluate(`fetch('/api/stats/watchtime?fixture=1').then(r=>r.status)`), 200);
  passed('media-stream-and-non-ad-requests-are-not-blocked');
  await evaluate(`window.levels=['hd720','medium'];window.actualQuality='medium';document.dispatchEvent(new Event('yt-navigate-finish'))`);
  await waitFor('window.actualQuality === "hd720"', '720p fallback');
  passed('missing-1080p-falls-back-to-720p');
  await evaluate(`window.levels=['tiny'];window.actualQuality='auto';document.dispatchEvent(new Event('yt-navigate-finish'))`);
  await waitFor('window.actualQuality === "tiny"', '144p-only fallback');
  passed('144p-only-video-remains-playable');
  await evaluate(`window.levels=['hd2160','hd1440','hd1080','hd720'];window.actualQuality='hd720';document.dispatchEvent(new Event('yt-navigate-finish'))`);
  await waitFor('window.actualQuality === "hd1080"', 'SPA quality reapplication');
  passed('quality-reapplied-on-spa-navigation');
  await evaluate(`const p=document.querySelector('#movie_player');const b=document.createElement('button');b.className='ytp-ad-skip-button-modern';b.textContent='Skip ad';b.onclick=()=>{window.skipClicks++;p.classList.remove('ad-showing');b.remove()};p.append(b);p.classList.add('ad-showing')`);
  await waitFor('window.skipClicks === 1', 'ad skip button');
  assert.equal(await evaluate('window.testTime'), 10);
  passed('ad-skip-button-clicked-without-seeking-content');
  await evaluate(`window.testTime=0;window.testDuration=30;document.querySelector('#movie_player').classList.add('ad-showing')`);
  await waitFor('window.testTime === 30', 'finite ad skipped');
  await evaluate(`document.querySelector('#movie_player').classList.remove('ad-showing');window.testTime=5;window.testDuration=120`);
  await sleep(1200);
  assert.equal(await evaluate('window.testTime'), 5);
  assert.equal(await evaluate('document.querySelector("video").playbackRate'), 1);
  await evaluate(`window.testTime=0;window.testDuration=Infinity;document.querySelector('#movie_player').classList.add('ad-showing')`);
  await sleep(1200);
  assert.equal(await evaluate('window.testTime'), 0);
  await evaluate(`document.querySelector('#movie_player').classList.remove('ad-showing')`);
  passed('finite-ad-seek-only-no-live-or-normal-video-seek');
  await waitFor('!!document.querySelector("#simpbrowser-youtube-settings")', 'settings UI');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{altKey:true,shiftKey:true,code:'KeyY'}))`);
  await evaluate(`const s=document.querySelector('#simpbrowser-youtube-settings').shadowRoot;s.querySelector('button[aria-controls="preferences"]').click();const q=s.querySelector('select');q.value='hd720';q.dispatchEvent(new Event('change'))`);
  await waitFor('window.actualQuality === "hd720"', 'settings quality selection');
  assert.equal((await evaluate(`JSON.parse(localStorage.getItem('simpbrowser.youtube.settings.v1'))`)).quality, 'hd720');
  assert.equal(await evaluate(`document.querySelector('#simpbrowser-youtube-settings').hidden`), false);
  passed('settings-ui-quality-change-and-storage');
  const counts = await evaluate(status);
  const displayed = await evaluate(`Object.fromEntries([...document.querySelector('#simpbrowser-youtube-settings').shadowRoot.querySelectorAll('[data-stat]')].map(node=>[node.dataset.stat,node.textContent]))`);
  assert.equal(Number(displayed.total), counts.blockedRequests + counts.nativeBlockedRequests);
  for (const key of ['blockedRequests','nativeBlockedRequests','cleanedResponses',
    'skippedAds','observedAdResources','playbackErrors','responseParseErrors']) {
    assert.equal(Number(displayed[key]), counts[key]);
  }
  assert.ok(displayed.records.includes('/ 128'));
  passed('statistics-ui-matches-real-counters');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(directory, 'settings.png'), Buffer.from(screenshot.data, 'base64'));
  const recordCountBeforeReset = await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics().events.length`);
  await evaluate(`document.querySelector('#simpbrowser-youtube-settings').shadowRoot.querySelector('#reset-statistics').click()`);
  const resetCounts = await evaluate(status);
  assert.equal(resetCounts.blockedRequests + resetCounts.nativeBlockedRequests, 0);
  assert.equal(resetCounts.cleanedResponses + resetCounts.skippedAds, 0);
  assert.equal(await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics().events.length`), recordCountBeforeReset);
  passed('statistics-reset-preserves-diagnostic-records');
  await navigate(fixtureUrl + '?persist=1');
  await waitFor(`${status}?.quality === 'hd720' && document.querySelector('#simpbrowser-youtube-settings')?.shadowRoot.querySelector('select')?.value === 'hd720' && window.actualQuality === 'hd720'`, 'quality persisted after navigation');
  passed('quality-persists-after-reload');
  await evaluate(`const s=document.querySelector('#simpbrowser-youtube-settings').shadowRoot;const a=s.querySelector('input');a.checked=false;a.dispatchEvent(new Event('change'))`);
  await waitFor(`${status}?.ads === false && !!window.ytInitialPlayerResponse?.playerAds`, 'disable ads after reload');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("ytd-ad-slot-renderer")).display'), 'none');
  await evaluate(`fetch('https://googleads.g.doubleclick.net/pagead/adview').then(r=>r.text())`);
  assert.equal(interceptedAds, 1);
  passed('ad-removal-can-be-disabled-and-restored-on-reload');
  if (!injected) {
    await evaluate(`new Promise(resolve=>{const image=new Image();image.onload=image.onerror=()=>resolve();image.src='https://googleads.g.doubleclick.net/pagead/unblocked-image';document.body.append(image)})`);
    assert.equal(interceptedAds, 2);
    passed('native-request-filter-respects-disabled-setting');
  }
  await evaluate(`(()=>{const now=Date.now;let clock=now();Date.now=()=>clock+=1001;const v=document.querySelector('video');for(let i=0;i<140;i++)v.dispatchEvent(new Event('error'));Date.now=now;})()`);
  const diagnostic = await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics()`);
  assert.equal(diagnostic.events.length, 128);
  assert.ok(diagnostic.counters.playbackErrors >= 140);
  assert.ok(!JSON.stringify(diagnostic).includes('private-token'));
  assert.ok(!JSON.stringify(diagnostic).includes('private-body'));
  assert.ok(!JSON.stringify(diagnostic).includes('https://'));
  assert.ok(diagnostic.events.every(event => Object.keys(event).every(
      key => ['type','at','count','transport','code'].includes(key))));
  passed('diagnostics-bounded-and-contain-no-request-data');
  await evaluate(`document.querySelector('#simpbrowser-youtube-settings').shadowRoot.querySelector('#clear-diagnostics').click()`);
  assert.equal(await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics().events.length`), 0);
  assert.equal(await evaluate(status + '.diagnostics'), true);
  assert.ok((await evaluate(status)).playbackErrors >= 140);
  passed('clear-records-preserves-counters-and-diagnostic-setting');
  await evaluate(`const input=document.querySelector('#simpbrowser-youtube-settings').shadowRoot.querySelector('input[aria-label="로컬 진단 기록"]');input.checked=false;input.dispatchEvent(new Event('change'));document.querySelector('video').dispatchEvent(new Event('error'))`);
  assert.equal(await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics().enabled`), false);
  assert.equal(await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics().events.length`), 0);
  assert.equal(await evaluate(`sessionStorage.getItem('simpbrowser.youtube.diagnostics.v1')`), null);
  passed('diagnostics-can-be-disabled-and-cleared');
  await evaluate(`localStorage.removeItem('simpbrowser.youtube.settings.v1');sessionStorage.removeItem('simpbrowser.youtube.diagnostics.v1')`);
  await navigate('https://youtube.com.evil.test/__simpbrowser_test');
  assert.equal(await evaluate('window.beforePage'), false);
  assert.equal(await evaluate(`typeof window[Symbol.for('simpbrowser.youtube.v1')]`), 'undefined');
  passed('no-injection-on-lookalike-or-unrelated-origins');
  if (!injected) {
    const before = interceptedAds;
    await evaluate(`document.documentElement.setAttribute('data-simpbrowser-ad-policy','on');new Promise(resolve=>{const image=new Image();image.onload=image.onerror=()=>resolve();image.src='https://googleads.g.doubleclick.net/pagead/other-site-image';document.body.append(image)})`);
    assert.equal(interceptedAds, before + 1);
    passed('native-filter-does-not-apply-to-unrelated-origins');
  }
  await navigate('https://www.youtube-nocookie.com/__simpbrowser_test');
  assert.equal(await evaluate('window.beforePage'), true);
  await waitFor('window.actualQuality === "hd1080"', 'privacy-enhanced embed quality');
  passed('privacy-enhanced-youtube-origin-supported');
  assert.deepEqual(networkErrors, []);
  await call('Fetch.disable');
  if (!injected) {
    await call('Page.navigate', { url: 'chrome://version/' });
    await waitFor(`document.querySelector('tr .label')?.textContent.trim() === 'SimpBrowser'`, 'SimpBrowser product label on version page');
    passed('simpbrowser-brand', await evaluate(`document.querySelector('tr .label').textContent.trim()`));
  }
  if (live) {
    await call('Page.navigate', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
    await waitFor(`!!document.querySelector('video') && !!window[Symbol.for('simpbrowser.youtube.v1')]`, 'live YouTube player', 90000);
    await evaluate(`document.querySelector('video').muted=true; document.querySelector('video').play().catch(()=>{})`);
    await waitFor(`document.querySelector('video')?.currentTime > 2 && document.querySelector('video')?.videoHeight > 0 && !document.querySelector('#movie_player')?.classList.contains('ad-showing')`, 'live YouTube playback', 90000);
    await sleep(10000);
    result.live = await evaluate(`({status:${status},video:{time:document.querySelector('video').currentTime,width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,paused:document.querySelector('video').paused},quality:document.querySelector('#movie_player')?.getPlaybackQuality?.(),levels:document.querySelector('#movie_player')?.getAvailableQualityLevels?.(),ad:document.querySelector('#movie_player')?.classList.contains('ad-showing')})`);
    result.diagnostics = await evaluate(`window[Symbol.for('simpbrowser.youtube.v1')].getDiagnostics()`);
    assert.equal(result.live.ad, false);
    assert.ok(result.live.video.time > 2);
    assert.equal(result.live.video.paused, false);
    assert.ok(result.live.quality === result.live.status.selectedQuality, JSON.stringify(result.live));
    const expectedHeight = { tiny: 144, small: 240, medium: 360, large: 480,
      hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160 }[result.live.status.selectedQuality];
    if (expectedHeight) assert.equal(result.live.video.height, expectedHeight,
        'Decoded video resolution must match the selected quality');
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, 'youtube-live.png'), Buffer.from(shot.data, 'base64'));
    passed('live-youtube-playback-and-quality', result.live);
  }
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  socket?.close();
  browser.stderr.destroy();
  browser.unref();
  if (browser.pid) {
    const cleanup = spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' });
    cleanup.on('error', () => {});
    cleanup.unref();
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(directory, 'browser-stderr.log'), stderr);
  console.log(JSON.stringify(result, null, 2));
}
