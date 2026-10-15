// 核心算法自检：node test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(core, '找不到 core 脚本');
const ctx = {}; vm.createContext(ctx); vm.runInContext(core, ctx);
const { MARD, PALETTE, quantize, nearest, hexRgb } = ctx.PDCore;

let n = 0;
const t = (name, fn) => { fn(); console.log('  ok  ' + name); n++; };

t('色卡完整且 hex 合法', () => {
  assert.equal(MARD.length, 295);
  for (const [code, hex] of MARD) {
    assert.match(code, /^[A-Z]{1,2}\d+$/);
    assert.match(hex, /^#[0-9A-F]{6}$/i);
  }
  assert.equal(new Set(MARD.map(c => c[0])).size, 295);
});

t('最近邻命中自身', () => {
  for (const i of [0, 57, 148, 260, 294]) {
    const p = PALETTE[i];
    assert.equal(nearest(p.r, p.g, p.b, PALETTE.map((_, k) => k)), i);
  }
});

t('纯黑比纯白更接近深色豆', () => {
  const all = PALETTE.map((_, i) => i);
  const black = nearest(0, 0, 0, all);
  assert.ok(hexRgb(PALETTE[black].hex).reduce((a, b) => a + b, 0) < 200, PALETTE[black].code);
});

// 8x8：四个 4x4 象限各填一种**精确命中**的色卡颜色
const QUAD = [0, 100, 200, 290];
const quadPx = new Uint8ClampedArray(8 * 8 * 4);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
  const j = (y * 8 + x) * 4, c = PALETTE[QUAD[(y < 4 ? 0 : 2) + (x < 4 ? 0 : 1)]];
  quadPx[j] = c.r; quadPx[j + 1] = c.g; quadPx[j + 2] = c.b; quadPx[j + 3] = 255;
}

t('不限色时逐像素精确还原', () => {
  const r = quantize(quadPx, 8, 8, { maxColors: 295 });
  assert.equal(r.colors.map(c => c.code).sort().join(), QUAD.map(i => PALETTE[i].code).sort().join());
  assert.ok(r.colors.every(c => c.count === 16));
  assert.equal(r.total, 64);
});

t('限色后不超上限，且只留入选色', () => {
  const r = quantize(quadPx, 8, 8, { maxColors: 2 });
  assert.equal(r.colors.length, 2);
  assert.equal(r.total, 64);
  const kept = new Set(r.colors.map(c => c.i));
  for (const i of r.idx) assert.ok(kept.has(i), '留下了未入选的颜色');
  assert.equal(r.colors.reduce((s, c) => s + c.count, 0), 64);
});

t('透明像素留空且不计入', () => {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    const j = i * 4, c = PALETTE[i < 8 ? 0 : 294];
    px[j] = c.r; px[j + 1] = c.g; px[j + 2] = c.b; px[j + 3] = i < 8 ? 255 : 0;
  }
  const r = quantize(px, 4, 4, { maxColors: 24 });
  assert.equal(r.colors.length, 1);
  assert.equal(r.total, 8);
  assert.equal([...r.idx].filter(i => i < 0).length, 8);
});

t('抖动的非空像素数不变、颜色不越界', () => {
  const r = quantize(quadPx, 8, 8, { maxColors: 3, dither: true });
  assert.ok(r.colors.length <= 3);
  assert.equal(r.total, 64);
});

console.log(`\n${n} 项通过`);
