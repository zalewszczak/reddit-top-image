/*
 * Reddit Top Image - PebbleOS plugin (source: social/reddit, one instance per subreddit preset).
 *
 * Fetches the top image post of a subreddit for the last hour / day / week / ... and serves the
 * picture (watch-ready) together with the post title, author, score and link.
 *
 * This file is bundled together with the vendored JPEG/PNG decoders into
 * src/plugin/index.js by tools/build-plugin.js. Plugin scripts are evaluated as a plain
 * script by the phone app (no module loader), so NEVER add import/export here;
 * use require('...') only for the modules registered in the build script.
 */
'use strict';

var jpegDecode = require('jpeg-decoder');
var UPNG = require('upng-js');

var VERSION = '1.1.0';
var SOURCE_KEY = 'social/reddit';
var USER_AGENT = 'pebble:reddit-top-image:1.1.0 (personal Pebble plugin)';
var TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
var API_HOST = 'oauth.reddit.com';
var TOKEN_KEY = 'reddit.token.v1';
var DEVICE_KEY = 'reddit.device.v1';
var LISTING_LIMIT = 30;

var SETTINGS_KEY = 'reddit.settings.v1';
var LISTING_PREFIX = 'reddit.list.v1:';
var LISTING_INDEX_KEY = 'reddit.listindex.v1';
var IMG_INDEX_KEY = 'reddit.imgindex.v1';
var IMG_PREFIX = 'reddit.img.v1:';
var ERROR_KEY = 'reddit.lasterror.v1';

var MAX_CACHED_LISTINGS = 12;
var MAX_CACHED_BITMAPS = 8;
var MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
var MAX_DECODE_PIXELS = 12000000;
var REQUEST_BUDGET_MS = 14000;       // the host gives a source request 20 s
var MAX_PRESETS = 4;
var BACKGROUND = [12, 12, 14];
var REQUIRED_HOSTS = ['www.reddit.com', 'i.redd.it', 'preview.redd.it'];

// How long a listing stays fresh: short periods change quickly, long ones hardly at all.
var PERIODS = {
  hour:  { label: 'past hour',  ttlMs: 10 * 60 * 1000 },
  day:   { label: 'past 24 hours', ttlMs: 30 * 60 * 1000 },
  week:  { label: 'past week',  ttlMs: 2 * 3600 * 1000 },
  month: { label: 'past month', ttlMs: 4 * 3600 * 1000 },
  year:  { label: 'past year',  ttlMs: 12 * 3600 * 1000 },
  all:   { label: 'all time',   ttlMs: 24 * 3600 * 1000 }
};
var STALE_TTL_MS = 10 * 60 * 1000;

// Offered in the settings page (any other subreddit can be typed in).
var SUGGESTED_SUBREDDITS = ['DigitalPhotoClub', 'AmateurPhotography', 'streetphotography', 'photographs', 'nocontextpics',
  'FairytaleasFuck', 'EarthPorn', 'geologyporn', 'BotanicalPorn', 'ruralporn', 'SkyPorn', 'pics', 'UtterlyUniquePhotos',
  'spaceporn', 'phonewallpapers', 'MobileWallpaper', 'wallpapers', 'AbandonedPorn', 'LiminalSpace', 'analogphotography',
  'analog', 'ArchitecturePorn', 'ExposurePorn', 'MinimalWallpaper', 'CityPorn', 'ArtPorn'];

var DEFAULT_PRESET = { id: 'p1', subreddit: 'EarthPorn', period: 'day', nsfw: false };
var DEFAULTS = {
  fit: 'fill',          // 'fill' crops to cover the screen, 'fit' letterboxes
  color: 'color',       // 'color' = best 16 of the 64 Pebble colours, 'gray' = 4 grays
  dither: true,
  dim: 0,               // 0..70 percent darkening, so watchface text stays readable
  videos: 'skip',       // 'skip' = still images only; 'thumb' = a video post's preview picture counts too
  titleShort: 'full'    // 'full' = whole title also in title.shortText, 'abbrev' = ~7 chars
};

function makeLog() {
  var lines = [];
  var t0 = Date.now();
  function log(message) {
    lines.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + message);
    try { console.log('APOD: ' + message); } catch (e) { /* ignore */ }
  }
  log.lines = lines;
  return log;
}

function errText(e) {
  return (e && e.message) ? String(e.message) : String(e);
}

function storeGet(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

function storeRemove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

function clampInt(v, lo, hi, fallback) {
  var n = Math.round(Number(v));
  if (!isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function decodeEntities(s) {
  var named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', ndash: '-',
    mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)', deg: '°'
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, body) {
    if (body.charAt(0) === '#') {
      var code = body.charAt(1).toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    var v = named[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function stripHtml(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function textOf(v) {
  if (v && typeof v === 'object') return v.rendered != null ? v.rendered : '';
  return v == null ? '' : v;
}

/** A short form for tiny slots: whole words up to ~7 characters, else a hard cut. */
function fitShort(text, max) {
  var s = oneLine(text);
  if (s.length <= max) return s;
  var words = s.split(' ');
  var out = '';
  for (var i = 0; i < words.length; i++) {
    var next = out ? out + ' ' + words[i] : words[i];
    if (next.length > max) break;
    out = next;
  }
  return out || s.slice(0, max);
}

function hostOf(url) {
  var m = /^https?:\/\/([^\/:?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}


// ---------------------------------------------------------------- image decoding and conversion

function hex(bytes, n) {
  var out = [];
  for (var i = 0; i < Math.min(n, bytes.length); i++) out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  return out.join(' ');
}

function sniffFormat(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  for (var i = 0; i < Math.min(b.length, 16); i++) {
    if (b[i] === 0x3C) return 'html';
    if (b[i] > 0x20) break;
  }
  return 'unknown';
}

function imageSize(b, fmt) {
  if (fmt === 'png' && b.length > 24) {
    return { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0,
             h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  }
  if (fmt === 'jpeg') {
    var i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      var m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}

/**
 * Download an image as REAL bytes. The phone app's fetch() only returns binary-safe data when
 * asked with responseType: 'arraybuffer'; without it the body is decoded as text and every
 * byte >= 0x80 is destroyed (PNG's 0x89 arrives as 0xFD).
 */
async function downloadImage(url, log) {
  var started = Date.now();
  log('GET ' + url);
  // No WebP decoder here: ask for JPEG/PNG first (preview.redd.it serves WebP when it is offered).
  var response = await fetch(url, { responseType: 'arraybuffer', headers: { 'Accept': 'image/png,image/jpeg;q=0.9,*/*;q=0.1', 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + hostOf(url));
  var length = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0) || 0;
  if (length > MAX_DOWNLOAD_BYTES) throw new Error('file is ' + Math.round(length / 1048576) + ' MB, too large');
  var type = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
  var buffer = await response.arrayBuffer();
  var bytes = new Uint8Array(buffer);
  var fmt = sniffFormat(bytes);
  log('downloaded ' + bytes.length + ' bytes in ' + (Date.now() - started) + ' ms, content-type "' + type + '", looks like ' + fmt + ', first bytes: ' + hex(bytes, 8));
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('file too large');
  if (fmt !== 'jpeg' && fmt !== 'png') {
    var hint = '';
    if (bytes.length > 2 && bytes[0] === 0xFD) {
      hint = ' (bytes look text-decoded: this phone app ignored responseType:"arraybuffer")';
    } else if (fmt === 'webp') {
      hint = ' (WebP is not supported)';
    }
    throw new Error('not a JPEG/PNG image: ' + fmt + hint);
  }
  return { bytes: bytes, buffer: buffer, format: fmt, contentType: type };
}

function decodeImage(file, log) {
  var started = Date.now();
  var size = imageSize(file.bytes, file.format);
  if (size) {
    log('image is ' + size.w + 'x' + size.h + ' (' + (size.w * size.h / 1e6).toFixed(1) + ' MP)');
    if (size.w * size.h > MAX_DECODE_PIXELS) {
      throw new Error('image is ' + size.w + 'x' + size.h + ', too big to decode on the phone');
    }
  }
  var out;
  if (file.format === 'jpeg') {
    var j = jpegDecode(file.bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true,
      maxResolutionInMP: 14, maxMemoryUsageInMB: 160 });
    out = { width: j.width, height: j.height, data: j.data };
  } else {
    var png = UPNG.decode(file.buffer);
    var frames = UPNG.toRGBA8(png);
    out = { width: png.width, height: png.height, data: new Uint8Array(frames[0]) };
  }
  log('decoded in ' + (Date.now() - started) + ' ms');
  return out;
}

// ---------------------------------------------------------------- scaling + quantising

/** Area-average downscale (bilinear when enlarging) into tw x th RGB, cover or letterbox. */
function scaleToTarget(img, tw, th, fit) {
  var src = img.data, sw = img.width, sh = img.height;
  var out = new Uint8Array(tw * th * 3);
  for (var i = 0; i < out.length; i += 3) { out[i] = BACKGROUND[0]; out[i + 1] = BACKGROUND[1]; out[i + 2] = BACKGROUND[2]; }

  // A picture that already fits entirely inside the target is not enlarged (that would look
  // pixelated): it is placed 1:1, centred horizontally and within the upper two thirds.
  if (sw <= tw && sh <= th) {
    var x0 = Math.floor((tw - sw) / 2);
    var y0 = Math.max(0, Math.min(th - sh, Math.floor((Math.floor(th * 2 / 3) - sh) / 2)));
    for (var yy = 0; yy < sh; yy++) {
      for (var xx = 0; xx < sw; xx++) {
        var sp = (yy * sw + xx) * 4, a0 = src[sp + 3] / 255, op = ((y0 + yy) * tw + x0 + xx) * 3;
        out[op] = src[sp] * a0 + BACKGROUND[0] * (1 - a0);
        out[op + 1] = src[sp + 1] * a0 + BACKGROUND[1] * (1 - a0);
        out[op + 2] = src[sp + 2] * a0 + BACKGROUND[2] * (1 - a0);
      }
    }
    return out;
  }

  var scale, srcX0, srcY0, srcW, srcH, dstX0, dstY0, dstW, dstH;
  if (fit === 'fit') {
    scale = Math.min(tw / sw, th / sh);
    dstW = Math.max(1, Math.round(sw * scale)); dstH = Math.max(1, Math.round(sh * scale));
    dstX0 = Math.floor((tw - dstW) / 2); dstY0 = Math.floor((th - dstH) / 2);
    srcX0 = 0; srcY0 = 0; srcW = sw; srcH = sh;
  } else {
    scale = Math.max(tw / sw, th / sh);
    srcW = Math.min(sw, tw / scale); srcH = Math.min(sh, th / scale);
    srcX0 = (sw - srcW) / 2; srcY0 = (sh - srcH) / 2;
    dstX0 = 0; dstY0 = 0; dstW = tw; dstH = th;
  }

  function put(dx, dy, r, g, b, a) {
    var o = ((dstY0 + dy) * tw + dstX0 + dx) * 3;
    if (a < 255) {
      var k = a / 255;
      r = r * k + BACKGROUND[0] * (1 - k); g = g * k + BACKGROUND[1] * (1 - k); b = b * k + BACKGROUND[2] * (1 - k);
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  }

  var x, y;
  if (scale >= 1) {
    // Enlarging: bilinear sampling.
    for (y = 0; y < dstH; y++) {
      var fy = srcY0 + (y + 0.5) * srcH / dstH - 0.5;
      var y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy))), y1 = Math.min(sh - 1, y0 + 1), wy = Math.max(0, Math.min(1, fy - y0));
      for (x = 0; x < dstW; x++) {
        var fx = srcX0 + (x + 0.5) * srcW / dstW - 0.5;
        var x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), x1 = Math.min(sw - 1, x0 + 1), wx = Math.max(0, Math.min(1, fx - x0));
        var p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
        var ch = [0, 0, 0, 0];
        for (var c = 0; c < 4; c++) {
          ch[c] = (src[p00 + c] * (1 - wx) + src[p10 + c] * wx) * (1 - wy) + (src[p01 + c] * (1 - wx) + src[p11 + c] * wx) * wy;
        }
        put(x, y, ch[0], ch[1], ch[2], ch[3]);
      }
    }
    return out;
  }

  // Shrinking: every source pixel in the region is added to the target cell its centre falls in.
  var sums = new Float32Array(dstW * dstH * 3);
  var counts = new Float32Array(dstW * dstH);
  var colMap = new Int32Array(sw);
  var xs0 = Math.max(0, Math.floor(srcX0)), xs1 = Math.min(sw, Math.ceil(srcX0 + srcW));
  var ys0 = Math.max(0, Math.floor(srcY0)), ys1 = Math.min(sh, Math.ceil(srcY0 + srcH));
  for (x = xs0; x < xs1; x++) {
    var cx = Math.floor((x + 0.5 - srcX0) * dstW / srcW);
    colMap[x] = (cx < 0 || cx >= dstW) ? -1 : cx;
  }
  for (y = ys0; y < ys1; y++) {
    var cy = Math.floor((y + 0.5 - srcY0) * dstH / srcH);
    if (cy < 0 || cy >= dstH) continue;
    var rowBase = y * sw;
    for (x = xs0; x < xs1; x++) {
      var cell = colMap[x];
      if (cell < 0) continue;
      var p = (rowBase + x) * 4;
      var a = src[p + 3] / 255;
      var t = (cy * dstW + cell);
      sums[t * 3] += src[p] * a + BACKGROUND[0] * (1 - a);
      sums[t * 3 + 1] += src[p + 1] * a + BACKGROUND[1] * (1 - a);
      sums[t * 3 + 2] += src[p + 2] * a + BACKGROUND[2] * (1 - a);
      counts[t] += 1;
    }
  }
  for (y = 0; y < dstH; y++) {
    for (x = 0; x < dstW; x++) {
      var q = y * dstW + x;
      if (counts[q] > 0) put(x, y, sums[q * 3] / counts[q], sums[q * 3 + 1] / counts[q], sums[q * 3 + 2] / counts[q], 255);
    }
  }
  return out;
}

function gcolor(r2, g2, b2) { return 0xC0 | (r2 << 4) | (g2 << 2) | b2; }

var GRAY_PALETTE = [gcolor(0, 0, 0), gcolor(1, 1, 1), gcolor(2, 2, 2), gcolor(3, 3, 3)];

function colorOf(byte) {
  return [((byte >> 4) & 3) * 85, ((byte >> 2) & 3) * 85, (byte & 3) * 85];
}

function dist(r1, g1, b1, r2, g2, b2) {
  var dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return 3 * dr * dr + 6 * dg * dg + db * db;
}

/** Greedily pick the n colours (out of the watch's 64) that best represent the image. */
function choosePalette(rgb, n) {
  var counts = new Float64Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
  var i;
  for (i = 0; i < rgb.length; i += 3) {
    var k = ((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4);
    counts[k]++; sr[k] += rgb[i]; sg[k] += rgb[i + 1]; sb[k] += rgb[i + 2];
  }
  var bins = [];
  for (i = 0; i < 4096; i++) if (counts[i] > 0) bins.push({ w: counts[i], r: sr[i] / counts[i], g: sg[i] / counts[i], b: sb[i] / counts[i] });
  var cands = [];
  for (var c = 0; c < 64; c++) {
    var byte = gcolor(c >> 4, (c >> 2) & 3, c & 3);
    var col = colorOf(byte);
    cands.push({ byte: byte, r: col[0], g: col[1], b: col[2], used: false });
  }
  var best = new Float64Array(bins.length);
  for (i = 0; i < best.length; i++) best[i] = Infinity;
  var palette = [];
  for (var round = 0; round < n; round++) {
    var bestGain = -1, bestIdx = -1;
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].used) continue;
      var gain = 0;
      for (i = 0; i < bins.length; i++) {
        var d = dist(bins[i].r, bins[i].g, bins[i].b, cands[ci].r, cands[ci].g, cands[ci].b);
        if (best[i] === Infinity) gain += bins[i].w * (1e6 - d); else if (d < best[i]) gain += bins[i].w * (best[i] - d);
      }
      if (gain > bestGain) { bestGain = gain; bestIdx = ci; }
    }
    if (bestIdx < 0 || (round > 0 && bestGain <= 0)) break;
    var pick = cands[bestIdx];
    pick.used = true;
    palette.push(pick.byte);
    for (i = 0; i < bins.length; i++) {
      var dd = dist(bins[i].r, bins[i].g, bins[i].b, pick.r, pick.g, pick.b);
      if (dd < best[i]) best[i] = dd;
    }
  }
  return palette;
}

/** Map RGB to palette indices, optionally with serpentine Floyd-Steinberg error diffusion. */
function quantize(rgb, w, h, paletteBytes, dither) {
  var pal = paletteBytes.map(colorOf);
  var idx = new Uint8Array(w * h);
  var buf = new Float32Array(rgb.length);
  for (var i = 0; i < rgb.length; i++) buf[i] = rgb[i];
  function nearest(r, g, b) {
    var bi = 0, bd = Infinity;
    for (var p = 0; p < pal.length; p++) {
      var d = dist(r, g, b, pal[p][0], pal[p][1], pal[p][2]);
      if (d < bd) { bd = d; bi = p; }
    }
    return bi;
  }
  for (var y = 0; y < h; y++) {
    var ltr = !dither || (y % 2 === 0);
    for (var s = 0; s < w; s++) {
      var x = ltr ? s : w - 1 - s;
      var o = (y * w + x) * 3;
      var r = Math.max(0, Math.min(255, buf[o])), g = Math.max(0, Math.min(255, buf[o + 1])), b = Math.max(0, Math.min(255, buf[o + 2]));
      var pi = nearest(r, g, b);
      idx[y * w + x] = pi;
      if (!dither) continue;
      var er = r - pal[pi][0], eg = g - pal[pi][1], eb = b - pal[pi][2];
      var dir = ltr ? 1 : -1;
      diffuse(buf, w, h, x + dir, y, 7 / 16, er, eg, eb);
      diffuse(buf, w, h, x - dir, y + 1, 3 / 16, er, eg, eb);
      diffuse(buf, w, h, x, y + 1, 5 / 16, er, eg, eb);
      diffuse(buf, w, h, x + dir, y + 1, 1 / 16, er, eg, eb);
    }
  }
  return idx;
}

function diffuse(buf, w, h, px, py, f, er, eg, eb) {
  if (px < 0 || px >= w || py >= h) return;
  var q = (py * w + px) * 3;
  buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f;
}

function toBase64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 4096) {
    var chunk = bytes.subarray(i, Math.min(bytes.length, i + 4096));
    var part = '';
    for (var j = 0; j < chunk.length; j++) part += String.fromCharCode(chunk[j]);
    s += part;
  }
  return btoa(s);
}

function packBitmap(idx, w, h, paletteBytes) {
  var stride = (w + 1) >> 1;
  var pixels = new Uint8Array(stride * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var v = idx[y * w + x] & 15;
      var o = y * stride + (x >> 1);
      pixels[o] |= (x & 1) ? v : (v << 4);
    }
  }
  return { pixels: toBase64(pixels), palette: toBase64(new Uint8Array(paletteBytes)), width: w, height: h };
}

function convert(img, w, h, settings, log) {
  var started = Date.now();
  var rgb = scaleToTarget(img, w, h, settings.fit);
  var i;
  if (settings.dim > 0) {
    var k = 1 - settings.dim / 100;
    for (i = 0; i < rgb.length; i++) rgb[i] = rgb[i] * k;
  }
  if (settings.color === 'gray') {
    for (i = 0; i < rgb.length; i += 3) {
      var l = rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = l;
    }
  }
  var palette = settings.color === 'gray' ? GRAY_PALETTE.slice() : choosePalette(rgb, 16);
  var idx = quantize(rgb, w, h, palette, settings.dither);
  var bitmap = packBitmap(idx, w, h, palette);
  log('converted to ' + w + 'x' + h + ', ' + palette.length + ' colours in ' + (Date.now() - started) + ' ms');
  return bitmap;
}

// ---------------------------------------------------------------- bitmap cache + pipeline

// ---------------------------------------------------------------- settings

function cleanSubreddit(v) {
  var s = String(v == null ? '' : v).trim().replace(/^https?:\/\/(www\.|old\.)?reddit\.com/i, '').replace(/^\/?r\//i, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9_+]{2,60}$/.test(s) ? s : '';
}

function sanitizePreset(p, index, used) {
  p = p || {};
  var id = /^[a-z0-9_-]{1,16}$/.test(p.id || '') ? p.id : 'p' + (index + 1);
  while (used[id]) id = id + 'x';
  used[id] = true;
  return {
    id: id,
    subreddit: cleanSubreddit(p.subreddit) || DEFAULT_PRESET.subreddit,
    period: PERIODS[p.period] ? p.period : DEFAULT_PRESET.period,
    nsfw: !!p.nsfw
  };
}

function sanitizeSettings(s) {
  s = s || {};
  var used = {}, presets = [];
  var list = Array.isArray(s.presets) ? s.presets.slice(0, MAX_PRESETS) : [];
  for (var i = 0; i < list.length; i++) presets.push(sanitizePreset(list[i], i, used));
  if (!presets.length) presets.push(sanitizePreset(DEFAULT_PRESET, 0, {}));
  return {
    presets: presets,
    fit: s.fit === 'fit' ? 'fit' : 'fill',
    color: s.color === 'gray' ? 'gray' : 'color',
    dither: s.dither === undefined ? DEFAULTS.dither : !!s.dither,
    dim: clampInt(s.dim, 0, 70, DEFAULTS.dim),
    clientId: /^[A-Za-z0-9_-]{6,60}$/.test(String(s.clientId || '').trim()) ? String(s.clientId).trim() : '',
    clientSecret: /^[A-Za-z0-9_-]{6,100}$/.test(String(s.clientSecret || '').trim()) ? String(s.clientSecret).trim() : '',
    videos: s.videos === 'thumb' ? 'thumb' : 'skip',
    titleShort: s.titleShort === 'abbrev' ? 'abbrev' : 'full'
  };
}

function loadSettings() { return sanitizeSettings(storeGet(SETTINGS_KEY)); }

// ---------------------------------------------------------------- Reddit listing

function sizedUrl(o) {
  return o && o.url && /^https:\/\//i.test(o.url) ? { w: Number(o.w || o.width) || 0, h: Number(o.h || o.height) || 0, url: o.url } : null;
}

/** Collect the picture URLs of one post: sized previews (small to large), the source, a direct link. */
function imagesOf(d) {
  var res = [], source = null, direct = '', i;
  if (d.is_gallery && d.gallery_data && d.gallery_data.items && d.gallery_data.items.length && d.media_metadata) {
    var m = d.media_metadata[d.gallery_data.items[0].media_id];
    if (m && m.status === 'valid') {
      (m.p || []).forEach(function (p) { var r = sizedUrl({ w: p.x, h: p.y, url: p.u }); if (r) res.push(r); });
      if (m.s) source = sizedUrl({ w: m.s.x, h: m.s.y, url: m.s.u });
    }
  }
  if (!res.length && !source) {
    var pv = d.preview && d.preview.images && d.preview.images[0];
    if (!pv && d.crosspost_parent_list && d.crosspost_parent_list[0]) {
      var cp = d.crosspost_parent_list[0];
      pv = cp.preview && cp.preview.images && cp.preview.images[0];
    }
    if (pv) {
      (pv.resolutions || []).forEach(function (p) { var r = sizedUrl(p); if (r) res.push(r); });
      source = sizedUrl(pv.source);
    }
  }
  var link = String(d.url_overridden_by_dest || d.url || '');
  if (/^https:\/\/(i\.redd\.it|i\.imgur\.com)\//i.test(link) && /\.(jpe?g|png)(\?|$)/i.test(link)) direct = link;
  res.sort(function (a, b) { return a.w - b.w; });
  return { resolutions: res, source: source, direct: direct };
}

function isVideoPost(d) {
  var hint = String(d.post_hint || '');
  return !!d.is_video || /video/.test(hint) || /^(v\.redd\.it|youtu\.be|(www\.)?youtube\.com|gfycat\.com|streamable\.com)$/i.test(String(d.domain || ''));
}

function normalizePost(d) {
  var img = imagesOf(d);
  if (!img.resolutions.length && !img.source && !img.direct) return null;
  return {
    id: String(d.id || d.name || ''),
    title: oneLine(decodeEntities(d.title || '')),
    author: String(d.author || '[deleted]'),
    subreddit: String(d.subreddit || ''),
    score: Number(d.score) || 0,
    comments: Number(d.num_comments) || 0,
    created: Number(d.created_utc) || 0,
    nsfw: !!d.over_18,
    video: isVideoPost(d),
    permalink: d.permalink ? 'https://www.reddit.com' + d.permalink : '',
    images: img
  };
}

function listingKey(preset) { return preset.subreddit.toLowerCase() + '|' + preset.period; }

function cacheListing(key, rec) {
  var index = storeGet(LISTING_INDEX_KEY) || [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  while (index.length > MAX_CACHED_LISTINGS) storeRemove(LISTING_PREFIX + index.shift());
  if (!storeSet(LISTING_PREFIX + key, rec)) { while (index.length > 1) storeRemove(LISTING_PREFIX + index.shift()); storeSet(LISTING_PREFIX + key, rec); }
  storeSet(LISTING_INDEX_KEY, index);
}

function httpProblem(status, host) {
  if (status === 404) return 'subreddit not found, banned or private (HTTP 404)';
  if (status === 403) return 'Reddit refused the request (HTTP 403 from ' + host + '): private or quarantined subreddit, or Reddit is blocking this client';
  if (status === 429) return 'Reddit is rate limiting requests (HTTP 429); try again in a few minutes';
  return 'HTTP ' + status + ' from ' + host;
}

function parsePosts(text, log) {
  var json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('Reddit did not answer with JSON (' + oneLine(String(text).slice(0, 60)) + ')'); }
  var children = json && json.data && json.data.children;
  if (!Array.isArray(children)) throw new Error('unexpected Reddit reply');
  var posts = [];
  children.forEach(function (c) {
    if (!c || !c.data) return;
    var p = normalizePost(c.data);
    if (p) posts.push(p);
  });
  log(children.length + ' posts, ' + posts.length + ' with a picture');
  return posts.slice(0, 20);
}

function hasCredentials(settings) { return !!(settings && settings.clientId); }

/** App-only OAuth token (no Reddit login needed): client_credentials with a secret, installed_client without. */
async function getToken(settings, log, force) {
  var sig = settings.clientId + ':' + urlHashSimple(settings.clientSecret);
  var rec = storeGet(TOKEN_KEY);
  if (!force && rec && rec.sig === sig && rec.exp - Date.now() > 60000) return rec.token;
  var body;
  if (settings.clientSecret) {
    body = 'grant_type=client_credentials';
  } else {
    var dev = storeGet(DEVICE_KEY);
    if (!dev) {
      dev = '';
      var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      for (var i = 0; i < 26; i++) dev += chars.charAt(Math.floor(Math.random() * chars.length));
      storeSet(DEVICE_KEY, dev);
    }
    body = 'grant_type=' + encodeURIComponent('https://oauth.reddit.com/grants/installed_client') + '&device_id=' + dev;
  }
  log('POST ' + TOKEN_URL + ' (' + (settings.clientSecret ? 'client_credentials' : 'installed_client') + ')');
  var response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(settings.clientId + ':' + (settings.clientSecret || '')), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
    body: body
  });
  var text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error('Reddit rejected the client ID / secret (HTTP ' + response.status + '). Check them, and that the app is set up as "script" (with secret) or "installed app" (leave the secret empty).');
  if (!response.ok) throw new Error('Reddit token request failed (HTTP ' + response.status + ')');
  var json;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!json || !json.access_token) throw new Error('Reddit token reply had no access_token' + (json && json.error ? ' (' + json.error + ')' : ''));
  storeSet(TOKEN_KEY, { sig: sig, token: json.access_token, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
  return json.access_token;
}

function urlHashSimple(u) {
  var h = 5381; u = String(u || '');
  for (var i = 0; i < u.length; i++) h = ((h * 33) ^ u.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function downloadListingOAuth(preset, settings, log) {
  var url = 'https://' + API_HOST + '/r/' + preset.subreddit + '/top?t=' + preset.period + '&limit=' + LISTING_LIMIT + '&raw_json=1';
  for (var attempt = 0; attempt < 2; attempt++) {
    var token = await getToken(settings, log, attempt > 0);
    log('GET ' + url);
    var response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
    if (response.status === 401 && attempt === 0) { log('token rejected, getting a new one'); storeRemove(TOKEN_KEY); continue; }
    if (!response.ok) {
      var msg = httpProblem(response.status, API_HOST);
      if (response.status === 403) msg = 'Reddit refused the request (HTTP 403): the subreddit is private, quarantined or banned, or this API app has not been approved for use yet';
      throw new Error(msg);
    }
    return parsePosts(await response.text(), log);
  }
  throw new Error('Reddit rejected the access token');
}

async function downloadListingJson(preset, log) {
  var url = 'https://www.reddit.com/r/' + preset.subreddit + '/top.json?t=' + preset.period + '&limit=' + LISTING_LIMIT + '&raw_json=1';
  log('GET ' + url);
  var response = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
  if (!response.ok) { var err = new Error(httpProblem(response.status, 'www.reddit.com')); err.status = response.status; throw err; }
  return parsePosts(await response.text(), log);
}

// ---- RSS fallback: no key needed, but only title/author/link/picture (no score, comments or NSFW flag).

function xmlText(block, tag) {
  var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? m[1] : '';
}

function urlWidth(url) {
  var m = /[?&]width=(\d+)/.exec(url);
  return m ? Number(m[1]) : 0;
}

function parseRss(xml, log) {
  var posts = [], total = 0, re = /<entry[\s>]([\s\S]*?)<\/entry>/gi, m;
  while ((m = re.exec(xml))) {
    total++;
    var e = m[1];
    var html = decodeEntities(xmlText(e, 'content'));          // the content is escaped HTML
    var title = oneLine(decodeEntities(stripHtml(xmlText(e, 'title'))));
    var id = (/<id>\s*(?:t3_)?([\w]+)\s*<\/id>/i.exec(e) || [])[1] || '';
    var author = oneLine(decodeEntities(xmlText(e, 'name'))).replace(/^\/?u\//i, '') || '[deleted]';
    var cat = /<category[^>]*\bterm="([^"]+)"/i.exec(e);
    var link = (/<link[^>]*\bhref="([^"]+)"/i.exec(e) || [])[1] || '';
    var updated = Date.parse(xmlText(e, 'updated') || xmlText(e, 'published'));
    var target = (/<a href="([^"]+)">\s*\[link\]\s*<\/a>/i.exec(html) || [])[1];
    target = target ? decodeEntities(target) : '';
    var res = [], seen = {};
    var imgRe = /<img[^>]*\bsrc="([^"]+)"/gi, im;
    while ((im = imgRe.exec(html))) {
      var u = decodeEntities(im[1]);
      if (/^https:\/\//i.test(u) && !seen[u]) { seen[u] = 1; var w = urlWidth(u) || 140; res.push({ w: w, h: w, url: u }); }
    }
    var th = /<media:thumbnail[^>]*\burl="([^"]+)"/i.exec(e);
    if (th) { var tu = decodeEntities(th[1]); if (/^https:\/\//i.test(tu) && !seen[tu]) res.push({ w: urlWidth(tu) || 140, h: urlWidth(tu) || 140, url: tu }); }
    res.sort(function (a, b) { return a.w - b.w; });
    var direct = /^https:\/\/(i\.redd\.it|i\.imgur\.com)\/.*\.(jpe?g|png)(\?|$)/i.test(target) ? target : '';
    if (!res.length && !direct) continue;                      // text post or nothing to show
    var host = hostOf(target);
    posts.push({
      id: id || String(posts.length), title: title, author: author, subreddit: cat ? cat[1] : '', score: null, comments: null,
      created: isNaN(updated) ? 0 : Math.floor(updated / 1000),
      nsfw: /\bnsfw\b|\b18\+/i.test(title), video: /^(v\.redd\.it|youtu\.be|(www\.)?youtube\.com|gfycat\.com|streamable\.com)$/.test(host),
      permalink: link, images: { resolutions: res, source: null, direct: direct }
    });
  }
  log(total + ' feed entries, ' + posts.length + ' with a picture');
  return posts.slice(0, 20);
}

async function downloadListingRss(preset, log) {
  var url = 'https://www.reddit.com/r/' + preset.subreddit + '/top/.rss?t=' + preset.period + '&limit=' + LISTING_LIMIT;
  log('GET ' + url);
  var response = await fetch(url, { headers: { 'Accept': 'application/atom+xml,application/xml;q=0.9,*/*;q=0.5', 'User-Agent': USER_AGENT } });
  if (!response.ok) { var err = new Error(httpProblem(response.status, 'www.reddit.com') + ' (RSS)'); err.status = response.status; throw err; }
  var text = await response.text();
  if (!/<feed[\s>]/i.test(text)) throw new Error('Reddit RSS reply was not a feed');
  return parseRss(text, log);
}

/** Sign-in or anonymous JSON first, then the RSS feed. Returns { posts, via }. */
async function downloadListing(preset, settings, log) {
  var primary;
  try {
    var withKey = hasCredentials(settings);
    return { posts: withKey ? await downloadListingOAuth(preset, settings, log) : await downloadListingJson(preset, log), via: withKey ? 'oauth' : 'json' };
  } catch (e) {
    primary = e; log('failed: ' + errText(e));
  }
  var rssError = null;
  try {
    return { posts: await downloadListingRss(preset, log), via: 'rss' };
  } catch (e2) {
    rssError = e2; log('RSS failed: ' + errText(e2));
  }
  var msg = errText(primary);
  if (!hasCredentials(settings) && primary.status !== 404) msg += '. Reddit blocks anonymous access (RSS fallback failed too: ' + errText(rssError) + '); add a Reddit API client ID in the plugin settings';
  var out = new Error(msg);
  out.name = primary && primary.name === 'NotAllowedError' ? 'NotAllowedError' : 'Error';
  throw out;
}

/** Cached listing if fresh, else download; on failure fall back to an older copy. */
async function getListing(preset, settings, log, opts) {
  opts = opts || {};
  var key = listingKey(preset), rec = storeGet(LISTING_PREFIX + key), ttl = PERIODS[preset.period].ttlMs;
  var usable = rec && !(rec.via === 'rss' && hasCredentials(settings));
  if (!opts.force && usable && Date.now() - rec.t < ttl) { log('listing from cache'); return { posts: rec.posts, via: rec.via, stale: false, ttlLeft: ttl - (Date.now() - rec.t) }; }
  try {
    var got = await downloadListing(preset, settings, log);
    cacheListing(key, { t: Date.now(), posts: got.posts, via: got.via });
    return { posts: got.posts, via: got.via, stale: false, ttlLeft: ttl };
  } catch (e) {
    if (rec && rec.posts) { log('using an older copy of the listing'); return { posts: rec.posts, via: rec.via, stale: true, ttlLeft: STALE_TTL_MS }; }
    throw e;
  }
}

function pickPost(posts, preset, settings) {
  for (var i = 0; i < posts.length; i++) {
    var p = posts[i];
    if (p.nsfw && !preset.nsfw) continue;
    if (p.video && settings.videos !== 'thumb') continue;
    return { post: p, skipped: i };
  }
  return null;
}

// ---------------------------------------------------------------- bitmap cache + pipeline

function bitmapKey(post, w, h, s) {
  return IMG_PREFIX + [post.id, w, h, s.fit, s.color, s.dither ? 1 : 0, s.dim].join('|');
}

function cacheBitmap(key, value) {
  var index = storeGet(IMG_INDEX_KEY) || [];
  index = index.filter(function (k) { return k !== key; });
  index.push(key);
  while (index.length > MAX_CACHED_BITMAPS) storeRemove(index.shift());
  if (!storeSet(key, value)) {
    while (index.length > 1) storeRemove(index.shift());
    storeSet(key, value);
  }
  storeSet(IMG_INDEX_KEY, index);
}

function clearCaches() {
  [[IMG_INDEX_KEY, ''], [LISTING_INDEX_KEY, LISTING_PREFIX]].forEach(function (pair) {
    var list = storeGet(pair[0]) || [];
    for (var i = 0; i < list.length; i++) storeRemove(pair[1] + list[i]);
    storeRemove(pair[0]);
  });
}

/** Smallest preview that still covers the target, then bigger ones, then the original, then smaller ones. */
function candidateUrls(post, tw, th, settings) {
  var res = post.images.resolutions, out = [];
  function add(u) { if (u && out.indexOf(u) < 0) out.push(u); }
  var enough = function (r) { return settings.fit === 'fit' ? (r.w >= tw || r.h >= th) : (r.w >= tw && r.h >= th); };
  var firstBig = -1, i;
  for (i = 0; i < res.length; i++) { if (enough(res[i])) { firstBig = i; break; } }
  if (firstBig >= 0) for (i = firstBig; i < res.length; i++) add(res[i].url);
  var src = post.images.source;
  if (src && src.w * src.h <= MAX_DECODE_PIXELS) add(src.url);
  add(post.images.direct);
  for (i = (firstBig >= 0 ? firstBig : res.length) - 1; i >= 0; i--) add(res[i].url);
  return out;
}

async function getBitmap(post, w, h, settings, log, opts) {
  opts = opts || {};
  var key = bitmapKey(post, w, h, settings);
  if (!opts.force) {
    var hit = storeGet(key);
    if (hit && hit.bitmap) { log('bitmap from cache'); return { bitmap: hit.bitmap, info: hit.info, cached: true }; }
  }
  var urls = candidateUrls(post, w, h, settings), lastError = null;
  if (!urls.length) throw new Error('post has no usable picture');
  for (var i = 0; i < urls.length; i++) {
    try {
      var file = await downloadImage(urls[i], log);
      var img = decodeImage(file, log);
      var bitmap = convert(img, w, h, settings, log);
      var info = { url: urls[i], bytes: file.bytes.length, format: file.format, sourceWidth: img.width, sourceHeight: img.height };
      cacheBitmap(key, { bitmap: bitmap, info: info });
      return { bitmap: bitmap, info: info, cached: false };
    } catch (e) { lastError = e; log('failed: ' + errText(e)); }
  }
  throw lastError || new Error('image download failed');
}

// ---------------------------------------------------------------- source properties

function compactCount(n) {
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
  return String(n);
}

function agoText(sec) {
  var d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm ago';
  if (d < 86400) return Math.round(d / 3600) + 'h ago';
  return Math.round(d / 86400) + 'd ago';
}

function propertiesFor(preset, post, wants, settings) {
  var p = {}, sub = 'r/' + preset.subreddit;
  if (wants('name')) p.name = { shortText: { text: sub }, longText: { text: sub + ' - top, ' + PERIODS[preset.period].label } };
  if (wants('period')) p.period = { shortText: { text: preset.period }, longText: { text: PERIODS[preset.period].label } };
  if (!post) {
    if (wants('title')) p.title = { shortText: { text: 'No picture' }, longText: { text: 'No picture post found in ' + sub + ' for the ' + PERIODS[preset.period].label } };
    return p;
  }
  if (wants('title')) p.title = { shortText: { text: settings.titleShort === 'abbrev' ? fitShort(post.title, 7) : post.title }, longText: { text: post.title } };
  if (wants('author')) p.author = { shortText: { text: 'u/' + post.author }, longText: { text: 'u/' + post.author } };
  if (wants('subreddit')) p.subreddit = { shortText: { text: 'r/' + post.subreddit }, longText: { text: 'r/' + post.subreddit } };
  if (wants('score') && post.score !== null) p.score = { numericValue: { value: post.score }, shortText: { text: compactCount(post.score) } };
  if (wants('comments') && post.comments !== null) p.comments = { numericValue: { value: post.comments }, shortText: { text: compactCount(post.comments) } };
  if (wants('posted') && post.created) p.posted = { timestamp: { value: Math.floor(post.created) }, shortText: { text: agoText(post.created) } };
  if (wants('permalink') && post.permalink) p.permalink = { longText: { text: post.permalink } };
  if (wants('image_url')) {
    var u = post.images.direct || (post.images.source && post.images.source.url) || '';
    if (u) p.image_url = { longText: { text: u } };
  }
  return p;
}

// ---------------------------------------------------------------- source handler

Pebble.registerSourceHandler(async function (request, respond) {
  if (request.category !== 'social' || request.item !== 'reddit') {
    respond.error('PLUGIN_UNAVAILABLE', 'this plugin only serves ' + SOURCE_KEY);
    return;
  }
  var started = Date.now(), log = makeLog(), settings = loadSettings();
  var wants = function (name) { return !request.properties || request.properties.indexOf(name) >= 0; };
  var size = request.iconPixelSize, instances = [], lastErr = null, okCount = 0, ttl = Infinity;
  for (var i = 0; i < settings.presets.length; i++) {
    var preset = settings.presets[i], post = null;
    try {
      if (Date.now() - started > REQUEST_BUDGET_MS) throw new Error('out of time budget');
      var listing = await getListing(preset, settings, log, {});
      ttl = Math.min(ttl, listing.ttlLeft);
      var pick = pickPost(listing.posts, preset, settings);
      post = pick && pick.post;
      var props = propertiesFor(preset, post, wants, settings);
      if (post && wants('image') && size) {
        try {
          var r = await getBitmap(post, clampInt(size.w, 1, 260, 144), clampInt(size.h, 1, 260, 168), settings, log, {});
          props.image = { image: r.bitmap };
        } catch (e) { lastErr = e; log('image for r/' + preset.subreddit + ' failed: ' + errText(e)); }
      }
      okCount++;
      instances.push({ instanceId: preset.id, properties: props });
    } catch (e) {
      lastErr = e; ttl = Math.min(ttl, STALE_TTL_MS);
      log('r/' + preset.subreddit + ' failed: ' + errText(e));
      instances.push({ instanceId: preset.id, properties: propertiesFor(preset, null, wants, settings) });
    }
  }
  if (lastErr) storeSet(ERROR_KEY, { at: Date.now(), message: errText(lastErr), log: log.lines.slice(-8) }); else storeRemove(ERROR_KEY);
  if (!okCount && lastErr) {
    respond.error(lastErr && lastErr.name === 'NotAllowedError' ? 'PERMISSION_DENIED' : 'UNKNOWN', errText(lastErr));
    return;
  }
  respond.data({ validUntilMs: Date.now() + (isFinite(ttl) ? ttl : STALE_TTL_MS), instances: instances });
});

// ---------------------------------------------------------------- config page conversation

async function missingPermissions(settings) {
  var perms = Pebble.permissions;
  if (!perms || typeof perms.query !== 'function') return null;
  var missing = [], hosts = hasCredentials(settings) ? [API_HOST].concat(REQUIRED_HOSTS) : REQUIRED_HOSTS;
  for (var i = 0; i < hosts.length; i++) {
    try {
      var state = await perms.query('Internet/' + hosts[i]);
      var value = state && typeof state === 'object' ? (state.state || state.status) : state;
      if (value && value !== 'granted') missing.push(hosts[i]);
    } catch (e) { /* unknown: don't nag */ }
  }
  return missing;
}

function periodList() {
  return Object.keys(PERIODS).map(function (id) { return { id: id, label: PERIODS[id].label }; });
}

Pebble.registerConfigHandler(async function (message, respond) {
  var type = message && message.type, log = makeLog();
  try {
    if (type === 'init') {
      respond({
        version: VERSION, settings: loadSettings(), defaults: sanitizeSettings({}), periods: periodList(), suggested: SUGGESTED_SUBREDDITS, maxPresets: MAX_PRESETS,
        defaultPreset: sanitizePreset(DEFAULT_PRESET, 0, {}),
        lastError: storeGet(ERROR_KEY),
        missingPermissions: await missingPermissions(loadSettings())
      });
    } else if (type === 'save') {
      var s = sanitizeSettings(message.settings);
      storeSet(SETTINGS_KEY, s);
      try { Pebble.refreshSources([SOURCE_KEY]); } catch (e) { /* ignore */ }
      respond({ ok: true, settings: s });
    } else if (type === 'testAuth') {
      var ts = sanitizeSettings(message.settings || loadSettings());
      var tr = { version: VERSION, hasCredentials: hasCredentials(ts) };
      if (!tr.hasCredentials) {
        tr.error = 'Enter the client ID first.';
      } else {
        try {
          await getToken(ts, log, true);
          var tp = sanitizePreset(message.preset || ts.presets[0], 0, {});
          var posts = await downloadListingOAuth(tp, ts, log);
          tr.ok = true; tr.message = 'Works: signed in to Reddit and read r/' + tp.subreddit + ' (' + posts.length + ' picture posts in the top list).';
        } catch (e) { tr.error = errText(e); }
      }
      tr.missingPermissions = await missingPermissions(ts);
      tr.log = log.lines;
      respond(tr);
    } else if (type === 'clearCache') {
      clearCaches();
      storeRemove(TOKEN_KEY);
      storeRemove(ERROR_KEY);
      respond({ ok: true });
    } else if (type === 'preview') {
      var settings = sanitizeSettings(message.settings || loadSettings());
      var preset = sanitizePreset(message.preset || settings.presets[0], 0, {});
      var w = clampInt(message.width, 1, 260, 144), h = clampInt(message.height, 1, 260, 168);
      var res = { version: VERSION, width: w, height: h, preset: preset };
      try {
        var listing = await getListing(preset, settings, log, { force: !!message.fresh });
        res.stale = listing.stale; res.via = listing.via;
        var pick = pickPost(listing.posts, preset, settings);
        if (!pick) {
          res.error = 'No usable picture post in the top ' + listing.posts.length + ' of r/' + preset.subreddit + ' (' + PERIODS[preset.period].label + ')' + (preset.nsfw ? '' : '; NSFW posts are hidden') + '.';
        } else {
          res.post = pick.post; res.skipped = pick.skipped;
          res.served = { titleShort: settings.titleShort === 'abbrev' ? fitShort(pick.post.title, 7) : pick.post.title, titleLong: pick.post.title };
          try {
            var r = await getBitmap(pick.post, w, h, settings, log, { force: true });
            res.image = r.bitmap; res.info = r.info;
            storeRemove(ERROR_KEY);
          } catch (e) { res.imageError = errText(e); }
        }
      } catch (e) { res.error = errText(e); }
      res.missingPermissions = await missingPermissions(settings);
      res.log = log.lines;
      respond(res);
    } else {
      respond({ error: 'unknown message type: ' + type });
    }
  } catch (e) {
    respond({ error: errText(e), log: log.lines });
  }
});
