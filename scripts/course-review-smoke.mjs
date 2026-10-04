import { chromium } from '../.tmp/browser-tools/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:4321';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/course-production.html');
  await page.waitForFunction(() => document.querySelectorAll('#items section').length === 15);
  await page.screenshot({ path: '.tmp/course-dashboard.png', fullPage: true });
  const state = await (await fetch(base + '/api/course-production')).json();
  const ready = state.entries.find(e => e.status === 'review_ready');
  const report = { timestamp: new Date().toISOString(), cards: 15, ready: state.entries.filter(e => e.status === 'review_ready').length, playing: null, errors };
  if (ready) {
    await page.goto(base + ready.reviewUrl);
    await page.waitForTimeout(1500);
    assert.equal((await page.request.get(base + ready.videoUrl)).status(), 200);
    await page.setContent('<video controls style="width:100%"></video>');
    await page.locator('video').evaluate((v, src) => { v.src = src; v.muted = true; }, base + ready.videoUrl);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.locator('video').evaluate(async v => { v.currentTime = 10; await v.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 10.3);
    await page.locator('video').evaluate(v => v.pause());
    report.playing = await page.locator('video').evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, currentTime: v.currentTime, decodedFrames: v.getVideoPlaybackQuality().totalVideoFrames }));
    assert.equal(report.playing.width, 1920); assert.equal(report.playing.height, 1080);
    await page.screenshot({ path: '.tmp/course-first-playback.png' });
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync('.tmp/course-browser-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
