// 核心算法自检：node test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(core, '找不到 core 脚本');
const ctx = {}; vm.createContext(ctx); vm.runInContext(core, ctx);
const { MARD, PALETTE, quantize, pixelate, despeckle, nearest, hexRgb } = ctx.PDCore;

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

// ---------- ① 像素化：取主色，而不是平均值 ----------
t('像素化取区域内主色，不产生平均出来的“脏色”', () => {
  const src = new Uint8ClampedArray(4 * 4);            // 4 个源像素 → 1 格
  const put = (i, r, g, b) => { src[i * 4] = r; src[i * 4 + 1] = g; src[i * 4 + 2] = b; src[i * 4 + 3] = 255; };
  put(0, 255, 0, 0); put(1, 255, 0, 0); put(2, 255, 0, 0); put(3, 0, 0, 255);
  const out = pixelate(src, 4, 1, 1, 1);
  assert.deepEqual([out[0], out[1], out[2], out[3]], [255, 0, 0, 255]);  // 平均会得到 (191,0,64)
});

t('像素化：过半透明则留空', () => {
  const src = new Uint8ClampedArray(4 * 4);
  src[3] = 255;                                        // 只 1/4 不透明
  for (let i = 1; i < 4; i++) { src[i * 4] = 10; src[i * 4 + 3] = 0; }
  assert.equal(pixelate(src, 4, 1, 1, 1)[3], 0);
});

// ---------- ② 降噪：去孤立杂色豆 ----------
const grid = (w, h, fill, patches = []) => {
  const a = new Int16Array(w * h).fill(fill);
  for (const [x, y, v] of patches) a[y * w + x] = v;
  return a;
};

t('降噪：孤立的单颗豆被周围颜色吃掉', () => {
  const g = grid(5, 5, 10, [[2, 2, 20]]);
  assert.equal(despeckle(g, 5, 5, 1)[12], 10);
  assert.equal(despeckle(g, 5, 5, 0)[12], 20, 'strength=0 应完全不改');
});

t('降噪：成片的色块不动（3×3 色块在强度 3 下仍保留）', () => {
  const patches = [];
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) patches.push([x, y, 20]);
  const g = grid(7, 7, 10, patches);
  const out = despeckle(g, 7, 7, 3);
  assert.equal(out[16], 20, '色块角上那格应保留');   // (2,2)
  assert.equal(out[24], 20, '色块中心应保留');       // (3,3)
});

t('降噪：强度越大删得越多（1×2 的小岛）', () => {
  const g = grid(5, 5, 10, [[1, 1, 20], [2, 1, 20]]);
  assert.equal(despeckle(g, 5, 5, 1)[6], 20, '强度1：保留 2 颗的小岛');
  assert.equal(despeckle(g, 5, 5, 2)[6], 10, '强度2：吃掉 2 颗的小岛');
});

t('降噪不改变非空像素数量', () => {
  const r = quantize(quadPx, 8, 8, { maxColors: 4, despeckle: 2 });
  assert.equal(r.total, 64);
  assert.ok(r.colors.every(c => c.count > 0));
});

console.log(`\n${n} 项通过`);
