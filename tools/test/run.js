// Runs the built plugin (src/plugin/index.js) in a node vm with a mock phone host + mock Reddit.
// usage: node tools/test/run.js [fixtureDir]      (fixtureDir needs small.jpg, tiny.jpg, big.jpg, square.png)
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', '..');
const fx = process.argv[2] || path.join(__dirname, 'fixtures');
const script = fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8');
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };

const RES = [[108, 61], [216, 122], [320, 180], [640, 360], [960, 540], [1080, 608]];
const post = (o) => {
  const id = o.id || 'a1', d = {
    id, name: 't3_' + id, title: o.title || 'A &amp; nice picture', author: o.author || 'someone', subreddit: o.sub || 'EarthPorn',
    score: o.score ?? 1234, num_comments: o.comments ?? 56, created_utc: 1762740000, over_18: !!o.nsfw, is_video: !!o.video,
    permalink: '/r/' + (o.sub || 'EarthPorn') + '/comments/' + id + '/x/', url: o.url || 'https://i.redd.it/' + id + '.jpg', domain: o.video ? 'v.redd.it' : 'i.redd.it',
  };
  if (o.video) d.post_hint = 'hosted:video';
  if (o.text) { d.url = 'https://www.reddit.com/r/x/comments/1'; d.domain = 'self.x'; return { kind: 't3', data: d }; }
  if (o.gallery) {
    d.is_gallery = true; d.gallery_data = { items: [{ media_id: 'm1' }] };
    d.media_metadata = { m1: { status: 'valid', m: 'image/jpg', p: RES.map(([x, y]) => ({ x, y, u: `https://preview.redd.it/gal-${x}.jpg?width=${x}&s=sig` })), s: { x: 4000, y: 2250, u: 'https://i.redd.it/gal-src.jpg' } } };
  } else {
    d.preview = { images: [{ source: { url: `https://preview.redd.it/${id}-src.jpg?auto=webp&s=sig`, width: 4000, height: 2250 }, resolutions: RES.map(([x, y]) => ({ url: `https://preview.redd.it/${id}-${x}.jpg?width=${x}&auto=webp&s=sig`, width: x, height: y })) }] };
  }
  return { kind: 't3', data: d };
};

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Atom feed as Reddit serves it: content is escaped HTML whose attribute values are escaped again.
function feedOf(children) {
  const entries = children.map(({ data: d }) => {
    const pv = d.preview && d.preview.images[0];
    const img = pv ? '<img src="' + esc(pv.resolutions[3].url) + '" alt="x" />' : '';
    const html = '<table><tr><td><a href="https://www.reddit.com' + d.permalink + '">' + img + '</a></td><td> submitted by <a href="https://www.reddit.com/user/' + d.author + '"> /u/' + d.author + ' </a><br/>' +
      (pv ? '<span><a href="' + esc(d.url) + '">[link]</a></span>' : '') + ' <span><a href="https://www.reddit.com' + d.permalink + '">[comments]</a></span></td></tr></table>';
    return '<entry><author><name>/u/' + d.author + '</name><uri>https://www.reddit.com/user/' + d.author + '</uri></author><category term="' + d.subreddit + '" label="r/' + d.subreddit + '"/>' +
      '<content type="html">' + esc(html) + '</content><id>t3_' + d.id + '</id>' + (pv ? '<media:thumbnail url="' + esc(pv.resolutions[0].url) + '"/>' : '') +
      '<link href="https://www.reddit.com' + d.permalink + '"/><updated>2025-11-10T03:00:00+00:00</updated><title>' + esc(d.title) + '</title></entry>';
  });
  return '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">' + entries.join('') + '</feed>';
}

function makeHost(opts = {}) {
  const store = {}; let handler, cfg; const reqs = [];
  const clock = { t: Date.UTC(2026, 10, 10, 12, 0, 0) };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const state = { listing: opts.listing || {}, hostFail: opts.hostFail || {}, rss: opts.rss, webpFor: opts.webpFor || (() => false), imageFail: opts.imageFail || (() => false) };
  const ctx = {
    console: { log() {}, info() {}, warn() {}, error() {} }, atob, btoa, Date: FakeDate, Math, JSON, Uint8Array, Float32Array, Float64Array, Int32Array, ArrayBuffer, Promise, Error, String, Number, Array, Object, RegExp, Infinity, isFinite, parseInt, Map,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    Pebble: { registerSourceHandler: f => { handler = f; }, registerConfigHandler: f => { cfg = f; }, refreshSources: () => {}, permissions: { query: async () => 'granted' } },
    fetch: async (url, init) => {
      reqs.push({ url, init });
      const res = (status, body, type) => ({ ok: status < 300, status, headers: { get: h => (h.toLowerCase() === 'content-type' ? type : null) }, text: async () => String(body), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
      if (url === 'https://www.reddit.com/api/v1/access_token') {
        state.tokenCalls = (state.tokenCalls || []).concat([{ init }]);
        const auth = Buffer.from(String(init.headers.Authorization || '').replace(/^Basic /, ''), 'base64').toString();
        if (auth !== state.cred) return res(401, '{"error":401}', 'application/json');
        return res(200, JSON.stringify({ access_token: 'tok' + state.tokenCalls.length, token_type: 'bearer', expires_in: state.expires || 3600, scope: '*' }), 'application/json');
      }
      const mo = /^https:\/\/oauth\.reddit\.com\/r\/([^\/]+)\/top\?(.*)$/.exec(url);
      if (mo) {
        const want = 'Bearer tok' + (state.tokenCalls || []).length;
        if (state.revoke) { state.revoke = false; return res(401, '', 'text/plain'); }
        if (init.headers.Authorization !== want) return res(401, '', 'text/plain');
        if (state.oauthStatus) return res(state.oauthStatus, '', 'text/html');
        const l2 = state.listing[mo[1].toLowerCase()];
        if (l2 === undefined) return res(404, '{}', 'application/json');
        return res(200, JSON.stringify({ kind: 'Listing', data: { children: l2 } }), 'application/json');
      }
      const mr = /^https:\/\/www\.reddit\.com\/r\/([^\/]+)\/top\/\.rss\?(.*)$/.exec(url);
      if (mr) {
        if (!state.rss) return res(state.rss === undefined ? 403 : 429, '', 'text/html');
        const l3 = state.listing[mr[1].toLowerCase()];
        if (!Array.isArray(l3)) return res(404, '', 'text/html');
        return res(200, feedOf(l3), 'application/atom+xml');
      }
      let m = /^https:\/\/(www|old)\.reddit\.com\/r\/([^\/]+)\/top\.json\?(.*)$/.exec(url);
      if (m) {
        const host = m[1] + '.reddit.com';
        if (state.hostFail[host]) return res(state.hostFail[host], '', 'text/html');
        const l = state.listing[m[2].toLowerCase()];
        if (l === undefined) return res(404, '{}', 'application/json');
        if (typeof l === 'number') return res(l, '', 'text/html');
        return res(200, JSON.stringify({ kind: 'Listing', data: { children: l } }), 'application/json');
      }
      m = /^https:\/\/(i\.redd\.it|preview\.redd\.it|i\.imgur\.com)\/([^?]+)/.exec(url);
      if (m) {
        const name = m[2];
        if (state.imageFail(url)) return res(404, Buffer.alloc(0), 'text/html');
        if (state.webpFor(url)) return res(200, Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]), 'image/webp');
        let f = /src|gal-src/.test(name) ? 'big.jpg' : (/tiny/.test(name) ? 'tiny.jpg' : (/\.png$/.test(name) ? 'square.png' : 'small.jpg'));
        let b = fs.readFileSync(path.join(fx, f));
        if (!(init && init.responseType === 'arraybuffer')) b = Buffer.from(Array.from(b).map(v => (v >= 0x80 ? 0xFD : v)));
        return res(200, b, f.endsWith('png') ? 'image/png' : 'image/jpeg');
      }
      return res(404, '', 'text/plain');
    },
  };
  ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(script, ctx, { filename: 'index.js' });
  return { ctx, reqs, store, clock, state, listingCalls: () => reqs.filter(r => /top\.json/.test(r.url)),
    source: (req) => new Promise(r => handler(req, { data: d => r({ data: d }), error: (c, msg) => r({ error: c + ': ' + msg }) })),
    config: (msg) => new Promise(r => cfg(msg, r)) };
}

function validBitmap(b, w, h) {
  const px = Buffer.from(b.pixels, 'base64'), pal = Buffer.from(b.palette, 'base64');
  return b.width <= w && b.height <= h && px.length === ((b.width + 1) >> 1) * b.height && pal.length >= 1 && pal.length <= 16 && pal.every(v => (v & 0xC0) === 0xC0);
}
const REQ = { category: 'social', item: 'reddit', iconPixelSize: { w: 200, h: 228 } };
const preset = (o) => Object.assign({ id: 'p1', subreddit: 'EarthPorn', period: 'day', nsfw: false }, o);
const save = (h, presets, extra) => h.config({ type: 'save', settings: Object.assign({ presets }, extra || {}) });
const inst = (r, i = 0) => r.data.instances[i].properties;

(async () => {
  // 1. Picks the first usable post: skips text, video, NSFW; serves title/author/score/etc.
  let h = makeHost({ listing: { earthporn: [post({ id: 't0', text: true }), post({ id: 'v0', video: true }), post({ id: 'n0', nsfw: true }), post({ id: 'ok1', title: 'Misty &amp; golden morning over the Dolomites at 2,500 m', author: 'alice', score: 12345, comments: 321 }), post({ id: 'ok2' })] } });
  let r = await h.source(REQ), p = inst(r);
  ok(r.data && r.data.instances.length === 1 && r.data.instances[0].instanceId === 'p1', 'one instance per subreddit preset');
  ok(p.title.longText.text === 'Misty & golden morning over the Dolomites at 2,500 m' && p.title.shortText.text === p.title.longText.text, 'full title (entities decoded) in short and long text');
  ok(p.author.shortText.text === 'u/alice' && p.subreddit.shortText.text === 'r/EarthPorn', 'author and subreddit');
  ok(p.score.numericValue.value === 12345 && p.score.shortText.text === '12.3k' && p.comments.numericValue.value === 321, 'score and comments');
  ok(p.posted.timestamp.value === 1762740000 && /ago$/.test(p.posted.shortText.text), 'posted timestamp');
  ok(p.permalink.longText.text === 'https://www.reddit.com/r/EarthPorn/comments/ok1/x/', 'permalink');
  ok(p.image && validBitmap(p.image.image, 200, 228), 'image is a valid 4bpp bitmap');
  ok(h.listingCalls().length === 1 && /\/r\/EarthPorn\/top\.json\?t=day&limit=\d+&raw_json=1$/.test(h.listingCalls()[0].url), 'listing URL: top, t=day, raw_json');
  ok(h.listingCalls()[0].init.headers['User-Agent'].includes('pebble:reddit-top-image'), 'User-Agent header sent');
  const imgReqs = h.reqs.filter(q => /redd\.it/.test(q.url));
  ok(imgReqs.length === 1 && /ok1-640\.jpg/.test(imgReqs[0].url), 'smallest preview covering 200x228 is chosen (640): ' + (imgReqs[0] || {}).url);
  ok(imgReqs[0].init.responseType === 'arraybuffer' && /image\/jpeg/.test(imgReqs[0].init.headers.Accept) && !/webp/.test(imgReqs[0].init.headers.Accept), 'binary fetch, no WebP in Accept');

  // 2. Caches.
  const n = h.reqs.length; h.clock.t += 60000;
  await h.source(REQ);
  ok(h.reqs.length === n, 'second request: listing and bitmap served from cache');
  h.clock.t += 31 * 60000;   // day listing TTL is 30 min
  await h.source(REQ);
  ok(h.listingCalls().length === 2 && h.reqs.filter(q => /redd\.it/.test(q.url)).length === 1, 'listing refreshed after its TTL, same post: bitmap still cached');

  // 3. Stale listing when Reddit fails.
  h.state.hostFail['www.reddit.com'] = 403; h.state.hostFail['old.reddit.com'] = 403; h.clock.t += 31 * 60000;
  r = await h.source(REQ);
  ok(r.data && inst(r).image && r.data.validUntilMs - h.clock.t <= 10 * 60000 + 5, 'Reddit blocked: older listing served, short retry time');

  // 4. JSON blocked -> RSS feed (no key needed).
  h = makeHost({ rss: true, listing: { earthporn: [post({ id: 't0', text: true }), post({ id: 'v0', video: true, title: 'vid', url: 'https://v.redd.it/v0' }), post({ id: 'x1', title: 'Feed &amp; picture', author: 'bob', url: 'https://i.redd.it/x1.jpg' })] }, hostFail: { 'www.reddit.com': 403 } });
  r = await h.source(REQ); p = inst(r);
  ok(r.data && p.image && validBitmap(p.image.image, 200, 228), 'JSON blocked: RSS feed gives a picture');
  ok(p.title.longText.text === 'Feed & picture' && p.author.shortText.text === 'u/bob' && p.subreddit.shortText.text === 'r/EarthPorn', 'RSS: title, author, subreddit');
  ok(!p.score && !p.comments && p.permalink.longText.text === 'https://www.reddit.com/r/EarthPorn/comments/x1/x/' && p.posted.timestamp.value > 0, 'RSS: no score/comments, but link and time');
  const rssImg = h.reqs.filter(q => /redd\.it/.test(q.url));
  ok(rssImg.length >= 1 && /^https:\/\/preview\.redd\.it\/x1-640\.jpg\?width=640&auto=webp&s=sig$/.test(rssImg[0].url), 'RSS: image URL unescaped correctly: ' + rssImg[0].url);
  ok(h.listingCalls().length === 1 && h.reqs.some(q => /top\/\.rss\?t=day/.test(q.url)), 'RSS requested after the JSON attempt');
  const pvr = await h.config({ type: 'preview', width: 200, height: 228, preset: preset(), settings: { presets: [preset()] } });
  ok(pvr.via === 'rss' && pvr.post.score === null && pvr.image, 'preview says it came via RSS');
  // RSS direct image link used when no preview is in the feed; NSFW-titled posts skipped.
  h = makeHost({ rss: true, listing: { earthporn: [post({ id: 'n9', title: '[NSFW] hmm' }), post({ id: 'k9', title: 'fine' })] }, hostFail: { 'www.reddit.com': 403 } });
  r = await h.source(REQ);
  ok(inst(r).title.longText.text === 'fine', 'RSS: posts titled NSFW are skipped by default');
  // With credentials that fail, RSS still saves the day.
  h = makeHost({ rss: true, listing: { earthporn: [post({ id: 'c9' })] } });
  h.state.cred = 'abcdef123456:s3cretvalue';
  await save(h, [preset()], { clientId: 'abcdef123456', clientSecret: 'wrongwrong' });
  r = await h.source(REQ);
  ok(r.data && inst(r).image && !inst(r).score, 'bad credentials: falls back to RSS');
  // Cached RSS listing is replaced once credentials work.
  h.state.cred = 'abcdef123456:wrongwrong';
  h.state.listing.earthporn = [post({ id: 'c9', score: 777 })];
  r = await h.source(REQ);
  ok(inst(r).score && inst(r).score.numericValue.value === 777, 'with working credentials the cached RSS listing is not reused');
  h = makeHost({ rss: true, listing: { earthporn: [post({ id: 'z1' })] }, hostFail: { 'www.reddit.com': 403 } });
  h.state.rss = false;
  r = await h.source(REQ);
  ok(r.error && /403/.test(r.error) && /RSS fallback failed/.test(r.error) && /API client ID/.test(r.error), 'JSON and RSS both fail: message names both and the fix: ' + r.error);

  // 5. Errors.
  h = makeHost({ listing: {} });
  r = await h.source(REQ);
  ok(r.error && /not found|404/.test(r.error), 'unknown subreddit -> clear error: ' + r.error);
  h = makeHost({ listing: { earthporn: 429 } });
  r = await h.source(REQ);
  ok(r.error && /rate limit/.test(r.error), 'rate limit reported: ' + r.error);
  h = makeHost({ listing: { earthporn: [post({ id: 'q' })] }, imageFail: () => true });
  r = await h.source(REQ);
  ok(r.data && inst(r).title && !inst(r).image, 'all image downloads fail: title still served, no image');
  h = makeHost({ listing: { earthporn: [post({ id: 't', text: true })] } });
  r = await h.source(REQ);
  ok(r.data && /No picture/.test(inst(r).title.shortText.text) && !inst(r).image, 'no picture posts at all: placeholder title');

  // 6. WebP is refused and the next candidate is tried.
  h = makeHost({ listing: { earthporn: [post({ id: 'w1' })] }, webpFor: (u) => /w1-640/.test(u) });
  r = await h.source(REQ);
  ok(r.data && inst(r).image && h.reqs.some(q => /w1-960/.test(q.url)), 'WebP answer -> tries a larger preview');

  // 7. Presets: several subreddits, period, NSFW, videos.
  h = makeHost({ listing: { earthporn: [post({ id: 'e1', sub: 'EarthPorn' })], pics: [post({ id: 'n1', nsfw: true, sub: 'pics', title: 'spicy' }), post({ id: 'p1x', sub: 'pics', title: 'safe' })], space: [post({ id: 'v1', video: true, sub: 'space', title: 'a video' })] } });
  await save(h, [preset({ id: 'a', subreddit: 'EarthPorn', period: 'hour' }), preset({ id: 'b', subreddit: 'pics' }), preset({ id: 'c', subreddit: 'space' })]);
  r = await h.source(REQ);
  ok(r.data.instances.length === 3 && r.data.instances.map(i => i.instanceId).join() === 'a,b,c', 'three presets -> three instances');
  ok(/t=hour/.test(h.listingCalls()[0].url), 'period hour passed to Reddit');
  ok(r.data.instances[1].properties.title.longText.text === 'safe', 'NSFW skipped by default');
  ok(r.data.instances[2].properties.title.shortText.text === 'No picture', 'video-only subreddit has no picture by default');
  await save(h, [preset({ id: 'b', subreddit: 'pics', nsfw: true }), preset({ id: 'c', subreddit: 'space' })], { videos: 'thumb' });
  r = await h.source(REQ);
  ok(r.data.instances[0].properties.title.longText.text === 'spicy', 'NSFW allowed when the subreddit preset says so');
  ok(r.data.instances[1].properties.title.longText.text === 'a video' && r.data.instances[1].properties.image, 'video preview picture used when enabled');
  ok(h.listingCalls().filter(c => /t=hour/.test(c.url)).length === 1, 'hour listing requested once');

  // 8. Gallery and abbreviated title.
  h = makeHost({ listing: { pics: [post({ id: 'g1', gallery: true, sub: 'pics', title: 'Gallery of long title words' })] } });
  await save(h, [preset({ subreddit: 'pics' })], { titleShort: 'abbrev' });
  r = await h.source(REQ);
  ok(r.data && inst(r).image && h.reqs.some(q => /gal-640/.test(q.url)), 'gallery posts use the first image');
  ok(inst(r).title.shortText.text.length <= 7 && inst(r).title.longText.text === 'Gallery of long title words', 'abbreviated short title, full long title');

  // 9. Small image is placed, not crashed; fit mode.
  h = makeHost({ listing: { pics: [post({ id: 'tiny1', sub: 'pics', url: 'https://i.redd.it/tiny1.jpg' })] } });
  const smallOnly = JSON.parse(JSON.stringify(post({ id: 'tiny1', sub: 'pics' })));
  smallOnly.data.preview.images[0].resolutions = [{ url: 'https://preview.redd.it/tiny1-108.jpg?width=108&s=x', width: 108, height: 61 }];
  smallOnly.data.preview.images[0].source = { url: 'https://preview.redd.it/tiny1-orig.jpg?s=x', width: 120, height: 90 };
  h = makeHost({ listing: { pics: [smallOnly] } });
  await save(h, [preset({ subreddit: 'pics' })]);
  r = await h.source(REQ);
  ok(r.data && validBitmap(inst(r).image.image, 200, 228), 'low-resolution post still produces an image');

  // 10. Config: init, save sanitising, preview.
  h = makeHost({ listing: { earthporn: [post({ id: 'c1' })] } });
  let init = await h.config({ type: 'init' });
  ok(init.settings.presets[0].subreddit === 'EarthPorn' && init.periods.length === 6 && init.maxPresets === 4 && init.suggested.length === 26 && init.suggested.includes('SkyPorn'), 'init returns defaults, period list and 26 suggested subreddits');
  let sv = await save(h, [preset({ subreddit: 'https://www.reddit.com/r/pics/top/' }), preset({ id: 'x2', subreddit: '/r/Space' }), preset({ id: 'x3', subreddit: 'bad name!' }), preset({ id: 'x4', period: 'decade' }), preset({ id: 'x5' })]);
  const ps = sv.settings.presets;
  ok(ps.length === 4 && ps[0].subreddit === 'pics' && ps[1].subreddit === 'Space' && ps[2].subreddit === 'EarthPorn' && ps[3].period === 'day', 'save cleans subreddit names, periods, max 4 presets');
  let pv = await h.config({ type: 'preview', width: 200, height: 228, preset: preset(), settings: { presets: [preset()], dither: true } });
  ok(pv.post && pv.post.title && pv.image && validBitmap(pv.image, 200, 228) && pv.info.sourceWidth > 0, 'preview returns the post, the bitmap and info');
  pv = await h.config({ type: 'preview', width: 100, height: 100, preset: preset({ subreddit: 'nosuchsub' }) });
  ok(pv.error && !pv.image, 'preview reports an error for an unknown subreddit: ' + pv.error);
  const clr = await h.config({ type: 'clearCache' });
  ok(clr.ok && !Object.keys(h.store).some(k => /^reddit\.(list|img)\.v1:/.test(k)), 'clear cache empties listing and bitmap caches');

  // 11. Reddit API login (OAuth).
  h = makeHost({ listing: { earthporn: [post({ id: 'o1' })] } });
  h.state.cred = 'abcdef123456:s3cretvalue';
  const creds = { clientId: 'abcdef123456', clientSecret: 's3cretvalue' };
  await save(h, [preset()], creds);
  r = await h.source(REQ);
  ok(r.data && inst(r).image && h.listingCalls().length === 0 && h.reqs.some(q => /^https:\/\/oauth\.reddit\.com\/r\/EarthPorn\/top\?t=day/.test(q.url)), 'with credentials the listing comes from oauth.reddit.com');
  const tc = h.state.tokenCalls[0].init;
  ok(tc.method === 'POST' && /grant_type=client_credentials/.test(tc.body) && /x-www-form-urlencoded/.test(tc.headers['Content-Type']), 'token request: POST client_credentials, form encoded, Basic auth');
  await save(h, [preset(), preset({ id: 'p2', subreddit: 'pics' })], creds);
  h.state.listing.pics = [post({ id: 'o2', sub: 'pics' })];
  h.clock.t += 31 * 60000; await h.source(REQ);
  ok(h.state.tokenCalls.length === 1, 'token reused for later requests');
  h.clock.t += 3700 * 1000; await h.source(REQ);
  ok(h.state.tokenCalls.length === 2, 'expired token is renewed');
  h.state.revoke = true; h.clock.t += 31 * 60000;
  r = await h.source(REQ);
  ok(r.data && inst(r).image && h.state.tokenCalls.length === 3, '401 on the API -> new token and retry');
  h = makeHost({ listing: { earthporn: [post({ id: 'o1' })] } });
  h.state.cred = 'abcdef123456:s3cretvalue';
  await save(h, [preset()], { clientId: 'abcdef123456', clientSecret: 'wrongwrong' });
  r = await h.source(REQ);
  ok(r.error && /rejected the client ID/.test(r.error), 'wrong secret -> clear message: ' + r.error);
  h = makeHost({ listing: { earthporn: [post({ id: 'o1' })] } });
  h.state.cred = 'abcdef123456:';
  await save(h, [preset()], { clientId: 'abcdef123456' });
  r = await h.source(REQ);
  ok(r.data && /grant_type=https%3A%2F%2Foauth\.reddit\.com%2Fgrants%2Finstalled_client&device_id=[a-z0-9]{26}$/.test(h.state.tokenCalls[0].init.body), 'no secret: installed_client grant with a device id');
  h = makeHost({ listing: { earthporn: [post({ id: 'o1' })] } });
  h.state.cred = 'abcdef123456:s3cretvalue'; h.state.oauthStatus = 403;
  await save(h, [preset()], creds);
  r = await h.source(REQ);
  ok(r.error && /403/.test(r.error) && /approved|private/.test(r.error), '403 with credentials explains approval/private: ' + r.error);
  h = makeHost({ listing: { earthporn: [post({ id: 'o1' })] } });
  h.state.cred = 'abcdef123456:s3cretvalue';
  let ta = await h.config({ type: 'testAuth', settings: Object.assign({ presets: [preset()] }, creds) });
  ok(ta.ok && /r\/EarthPorn/.test(ta.message), 'Test credentials button: ' + (ta.message || ta.error));
  ta = await h.config({ type: 'testAuth', settings: { presets: [preset()], clientId: 'abcdef123456', clientSecret: 'badbadbad' } });
  ok(!ta.ok && /rejected/.test(ta.error), 'Test credentials with a bad secret fails clearly');
  ta = await h.config({ type: 'testAuth', settings: { presets: [preset()] } });
  ok(!ta.ok && /client ID/.test(ta.error), 'Test credentials without an ID asks for it');
  // Anonymous failure message points at the real problem, not at the fallback host's 404.
  h = makeHost({ listing: {}, hostFail: { 'www.reddit.com': 403 } });
  r = await h.source(REQ);
  ok(r.error && /403/.test(r.error) && /API client ID/.test(r.error), 'anonymous: 403 reported with advice to add API credentials: ' + r.error);

  // 12. Wrong source.
  r = await h.source({ category: 'space', item: 'apod' });
  ok(r.error && /PLUGIN_UNAVAILABLE/.test(r.error), 'other sources are refused');

  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
