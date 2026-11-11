// Loads src/config.html in headless Chromium with the real plugin bundle behind a mock Pebble host.
// usage: node tools/test/browser.js <fixtureDir> <screenshotDir>
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', '..');
const fx = process.argv[2], shots = process.argv[3];
const mock = `
  (function(){ var src=null,cfg=null;
    window.Pebble = { registerSourceHandler:function(f){src=f}, registerConfigHandler:function(f){cfg=f}, refreshSources:function(){},
      permissions:{ query:function(){ return Promise.resolve(window.__denied||'granted'); } },
      sendMessage:function(t,m){ return new Promise(function(res){ cfg(m,res); }); },
      addEventListener:function(ev,fn){ if(ev==='ready') setTimeout(function(){ fn({target:'plugin'}); },50); } };
  })();`;
const RES = [[108, 61], [216, 122], [320, 180], [640, 360], [960, 540]];
const child = (id, sub, title) => ({ kind: 't3', data: { id, title, author: 'photog', subreddit: sub, score: 4321, num_comments: 99, created_utc: 1762740000, over_18: false, permalink: '/r/' + sub + '/comments/' + id + '/x/', url: 'https://i.redd.it/' + id + '.jpg', preview: { images: [{ source: { url: 'https://preview.redd.it/' + id + '-src.jpg', width: 4000, height: 2250 }, resolutions: RES.map(([x, y]) => ({ url: 'https://preview.redd.it/' + id + '-' + x + '.jpg', width: x, height: y })) }] } } });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const cors = { 'access-control-allow-origin': '*' };
  await page.route('https://www.reddit.com/r/**', r => { const sub = /\/r\/([^\/]+)\//.exec(r.request().url())[1]; r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ data: { children: [child('abc' + sub.length, sub, 'Golden hour over the lake & the mountains behind it, taken from the north shore') ] } }) }); });
  await page.route('https://preview.redd.it/**', r => r.fulfill({ status: 200, headers: cors, contentType: 'image/jpeg', body: fs.readFileSync(path.join(fx, 'small.jpg')) }));
  await page.addInitScript({ content: mock });
  await page.addInitScript({ content: fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8') });
  await page.goto('file://' + path.join(root, 'src/config.html'));
  await page.waitForFunction(() => /^Works/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  console.log('status:', await page.textContent('#status'));
  console.log('meta:', (await page.textContent('#meta')).slice(0, 160));
  await page.screenshot({ path: path.join(shots, 'reddit-config-1.png'), fullPage: true });
  await page.click('#tabs button:last-child'); await page.selectOption('#subSelect', 'pics'); await page.selectOption('#period', 'hour');
  await page.waitForFunction(() => /Works/.test(document.getElementById('status').textContent) && /r\/pics/.test(document.getElementById('meta').textContent), null, { timeout: 15000 });
  await page.selectOption('#subSelect', '__custom'); await page.fill('#subreddit', 'itookapicture');
  await page.waitForFunction(() => /r\/itookapicture/.test(document.getElementById('meta').textContent), null, { timeout: 15000 });
  console.log('custom ok, options:', await page.evaluate(() => document.getElementById('subSelect').options.length));
  console.log('tabs:', await page.textContent('#tabs'));
  await page.click('#save'); await page.waitForFunction(() => /^Saved/.test(document.getElementById('status').textContent));
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, 'reddit-config-2.png'), fullPage: true });
  console.log('page errors:', JSON.stringify(errors));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
