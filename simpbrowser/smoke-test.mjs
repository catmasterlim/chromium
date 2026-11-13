import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'simpbrowser/test-results');
const profile = path.join(artifacts, `profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const browser = spawn(path.join(root, 'out/SimpBrowser/chrome.exe'), [
  '--headless', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
let spawnError;
browser.on('error', error => { spawnError = error; });
browser.stderr.on('data', chunk => { stderr += chunk; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = { startedAt: new Date().toISOString(), checks: [] };
let socket;
try {
  let port;
  for (let i = 0; i < 120; i++) {
    if (spawnError) throw spawnError;
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`);
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await delay(500); }
  }
  assert.ok(port, 'Chromium must start its debugging endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timeout);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  results.version = await call('Browser.getVersion');
  results.checks.push({ name: 'browser-start', passed: true });
  const html = '<!doctype html><meta charset="utf-8"><title>SimpBrowser smoke test</title><h1>Chromium rendering test</h1><canvas width="320" height="180"></canvas><video muted playsinline></video>';
  await call('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  for (let i = 0; i < 40; i++) {
    if (await evaluate('document.title') === 'SimpBrowser smoke test') break;
    await delay(250);
  }
  assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Chromium rendering test');
  assert.equal(await evaluate('21 * 2'), 42);
  results.checks.push({ name: 'html-and-javascript', passed: true });
  const sample = await readFile(path.join(root, 'media/test/data/bear-320x240.webm'));
  const sampleUrl = `data:video/webm;base64,${sample.toString('base64')}`;
  const media = await evaluate(`(async () => {
    const video = document.querySelector('video');
    video.src = ${JSON.stringify(sampleUrl)};
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = { currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight, error: video.error?.message, vp9: video.canPlayType('video/webm; codecs="vp9"'), av1: video.canPlayType('video/mp4; codecs="av01.0.05M.08"') };
    video.pause();
    return result;
  })()`);
  assert.ok(media.currentTime > 0.1 && media.width === 320 && !media.error, JSON.stringify(media));
  results.checks.push({ name: 'webm-playback', passed: true, details: media });
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(artifacts, 'smoke.png'), Buffer.from(screenshot.data, 'base64'));
  await call('Page.navigate', { url: 'https://www.youtube.com/' });
  let youtube;
  for (let i = 0; i < 60; i++) {
    youtube = await evaluate('({ url: location.href, title: document.title, ready: document.readyState, app: !!document.querySelector("ytd-app") })');
    if (youtube.app && youtube.ready === 'complete') break;
    await delay(500);
  }
  assert.ok(youtube.app && youtube.url.startsWith('https://www.youtube.com/'), JSON.stringify(youtube));
  results.checks.push({ name: 'youtube-homepage', passed: true, details: youtube });
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = String(error.stack || error);
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
  results.finishedAt = new Date().toISOString();
  await writeFile(path.join(artifacts, 'smoke.json'), JSON.stringify(results, null, 2));
  await writeFile(path.join(artifacts, 'browser-stderr.log'), stderr);
  console.log(JSON.stringify(results, null, 2));
}
