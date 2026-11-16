/**
 * シアニンのスキルのアイコン（2026-11-16 v1.112.0 開発部・Naoki OK 10:18）。計算だけ。
 * アプリのアイコン（claude/icon-rules.md）と同じ葉の形・2 つの丸いくぼみ・S 字の波・線 1 本の絵・文字なしを使い、
 * 白黒を反転させる：アプリ＝濃い地に白い線／スキル＝薄い地に色の線と色の縁。色はスキルごとではなくジャンルで決まる。
 * 置き場：skills/<name>/assets/icon.svg（大）・assets/icon-small.svg（24px 以下用）・agents/openai.yaml（ChatGPT／Codex が読む）
 */
import { GENRES } from "./skills-core.js";

/** ジャンルの色（線と縁）。アプリの 23 色からの距離（CIEDE2000）は 7.7〜10.4。地を反転させるので取り違えない */
export const GENRE_COLORS: Record<(typeof GENRES)[number], string> = {
  "文章": "#25418f",
  "図解・デザイン": "#a6431a",
  "分析・レビュー": "#127a6a",
  "戦略・企画": "#6a3c9a",
  "販売・集客": "#a8355c",
  "運営・仕組み": "#52525b",
};

const LEAF = "M44 0H114A14 14 0 0 1 128 14V84A44 44 0 0 1 84 128H14A14 14 0 0 1 0 114V44A44 44 0 0 1 44 0Z";
const WAVE = "M0 128V58C34 58 40 82 64 82S94 104 128 104V128Z";

/** 色を白へ寄せる（地の色）。t＝元の色の割合 */
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(255 - (255 - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** 絵（24×24 の白い線の中身）に使ってよい形だけを通す。スクリプトや外の住所を入れさせないため */
export function checkGlyph(glyph: string): string | null {
  const g = glyph.trim();
  if (!g || g.length > 2000) return "絵が空か長すぎる（2000 文字まで）";
  const tags = g.match(/<[^>]*>/g) || [];
  const rest = g.replace(/<[^>]*>/g, "").trim();
  if (rest) return "絵は path・circle・rect・line・polyline・ellipse の要素だけ";
  for (const t of tags) {
    if (!/^<(path|circle|rect|line|polyline|ellipse)(\s+(d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points)="[-0-9.,\sMmLlHhVvCcSsQqTtAaZz]*")*\s*\/>$/.test(t)) return `使えない形：${t.slice(0, 60)}`;
  }
  return null;
}

export function skillIconSvg(genre: string, glyph: string, small = false, px = 128): string {
  const col = (GENRE_COLORS as Record<string, string>)[genre] || GENRE_COLORS["運営・仕組み"];
  const tr = small ? "translate(14 14) scale(4.17)" : "translate(22 22) scale(3.5)";
  const sw = small ? 2.9 : 2.3;
  const bite = small ? '<circle cx="132" cy="40" r="19"/><circle cx="-4" cy="90" r="19"/>' : '<circle cx="132" cy="40" r="15"/><circle cx="-4" cy="88" r="15"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 128 128">`
    + `<defs><clipPath id="c"><path d="${LEAF}"/></clipPath><mask id="m"><rect x="-10" y="-10" width="150" height="150" fill="#fff"/><g fill="#000">${bite}</g></mask></defs>`
    + `<g mask="url(#m)"><g clip-path="url(#c)"><rect width="128" height="128" fill="${tint(col, 0.12)}"/><path d="${WAVE}" fill="${col}" fill-opacity=".16"/></g>`
    + `<path d="${LEAF}" fill="none" stroke="${col}" stroke-width="${small ? 7 : 5}" clip-path="url(#c)"/>`
    + `<g transform="${tr}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${glyph.trim()}</g></g></svg>`;
}

/** icon.svg から絵を取り出す（ジャンルを変えたとき色だけ作り直すため） */
export function glyphFromSvg(svg: string): string | null {
  const m = /<g transform="translate\([^"]*\) scale\([^"]*\)"[^>]*>([\s\S]*?)<\/g><\/g><\/svg>\s*$/.exec(svg);
  return m ? m[1] : null;
}

const yq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/** ChatGPT／Codex がスキルの見た目に使う agents/openai.yaml。名前と説明は SKILL.md の表示名と何に使うか */
export function openaiYaml(o: { title: string; purpose: string; genre: string }): string {
  const col = (GENRE_COLORS as Record<string, string>)[o.genre] || GENRE_COLORS["運営・仕組み"];
  const short = o.purpose.length > 64 ? o.purpose.slice(0, 63) + "…" : o.purpose;
  return `# シアニン式スキル規格のアイコン（正本の STANDARD.md 7 節）。SKILL.md の表示名・何に使う・ジャンルから作る\ninterface:\n  display_name: ${yq(o.title)}\n  short_description: ${yq(short)}\n  icon_small: "./assets/icon-small.svg"\n  icon_large: "./assets/icon.svg"\n  brand_color: "${col}"\n`;
}
