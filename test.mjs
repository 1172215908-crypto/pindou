// 核心算法自检：node test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(core, '找不到 core 脚本');
const ctx = {}; vm.createContext(ctx); vm.runInContext(core, ctx);
const { MARD, PALETTE, OUTLINE_IDX, quantize, style, outline, pixelate, despeckle, nearest, hexRgb } = ctx.PDCore;

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

// ---------- ⓪ 像素画风：提饱和 + 压色阶 ----------
const onePx = (r, g, b) => Uint8ClampedArray.from([r, g, b, 255]);

t('像素画风：饱和度 0 会变灰（R=G=B）', () => {
  const o = style(onePx(200, 40, 90), { sat: 0 });
  assert.ok(o[0] === o[1] && o[1] === o[2], `得到 ${o[0]},${o[1]},${o[2]}`);
});

t('像素画风：饱和度 100% 原样通过', () => {
  const o = style(onePx(200, 40, 90), { sat: 1, levels: 0 });
  assert.deepEqual([o[0], o[1], o[2]], [200, 40, 90]);
});

t('像素画风：色阶压缩不得把中性灰变成彩色（色相偏移回归）', () => {
  for (const v of [40, 90, 128, 170, 215, 240]) {
    const o = style(onePx(v, v, v), { sat: 1.4, levels: 6 });
    const d = Math.max(o[0], o[1], o[2]) - Math.min(o[0], o[1], o[2]);
    assert.ok(d <= 6, `灰 ${v} 被染成了 (${o[0]},${o[1]},${o[2]})`);
  }
});

t('像素画风：色阶按亮度分档（暗的压到 0、中高亮抬到 255）', () => {
  const lo = style(onePx(60, 60, 60), { sat: 1, levels: 2 });
  const hi = style(onePx(128, 128, 128), { sat: 1, levels: 2 });
  assert.ok(lo[0] < 20, '低亮度应压到 0，实际 ' + lo[0]);
  assert.ok(hi[0] > 235, '中高亮度应抬到 255，实际 ' + hi[0]);
});

t('像素画风：色阶不颠倒色相（红>绿>蓝 仍成立）', () => {
  const o = style(onePx(200, 60, 40), { sat: 1, levels: 4 });
  assert.ok(o[0] > o[1] && o[1] >= o[2], `得到 (${o[0]},${o[1]},${o[2]})`);
});

// ---------- ⓪' 描边 ----------
const WHITE = PALETTE.findIndex(p => p.code === 'H2');   // #FFFFFF
const GREY  = PALETTE.findIndex(p => p.code === 'H5');   // #464648

t('描边：明暗交界处在较暗的一侧压深色，亮侧不动', () => {
  // 4×2：左两列深灰、右两列白
  const g = new Int16Array([GREY, GREY, WHITE, WHITE, GREY, GREY, WHITE, WHITE]);
  const o = outline(g, 4, 2, 2);
  assert.equal(o[1], OUTLINE_IDX, '深灰那格贴着白，应被描边');
  assert.equal(o[0], GREY, '深灰内部不该被描边');
  assert.equal(o[2], WHITE, '白的那侧不该被描边');
});

t('描边：level 0 完全不改；对比不够时不描', () => {
  const g = new Int16Array([GREY, GREY, WHITE, WHITE, GREY, GREY, WHITE, WHITE]);
  assert.deepEqual([...outline(g, 4, 2, 0)], [...g]);
  // 两个亮度接近的浅色之间不该出现黑边
  const L1 = PALETTE.findIndex(p => p.code === 'H9'), L2 = PALETTE.findIndex(p => p.code === 'H10');
  const g2 = new Int16Array([L1, L1, L2, L2, L1, L1, L2, L2]);
  assert.deepEqual([...outline(g2, 4, 2, 1)], [...g2]);
});

t('描边在最深一级可以正常触发', () => {
  const g = new Int16Array([GREY, GREY, WHITE, WHITE, GREY, GREY, WHITE, WHITE]);
  assert.equal(outline(g, 4, 2, 3)[1], OUTLINE_IDX);
});

console.log(`\n${n} 项通过`);
