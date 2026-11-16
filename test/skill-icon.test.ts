import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGlyph, glyphFromSvg, openaiYaml, skillIconSvg, GENRE_COLORS } from "../src/skill-icon-core.ts";
import { GENRES } from "../src/skills-core.ts";

const G = '<circle cx="12" cy="12" r="8.5"/><path d="M15.6 8.4l-2.3 4.9-4.9 2.3 2.3-4.9z"/>';

test("6 つのジャンルに色がある", () => { for (const g of GENRES) assert.match(GENRE_COLORS[g], /^#[0-9a-f]{6}$/); });

test("絵は線の要素だけを通す", () => {
  assert.equal(checkGlyph(G), null);
  assert.ok(checkGlyph('<script>alert(1)</script>'));
  assert.ok(checkGlyph('<image href="https://x.example/a.png"/>'));
  assert.ok(checkGlyph('<path d="M0 0" onload="x()"/>'));
  assert.ok(checkGlyph(""));
});

test("ジャンルの色で描き、絵を取り出せる（ジャンルを変えたら色だけ作り直すため）", () => {
  const svg = skillIconSvg("文章", G);
  assert.ok(svg.includes(GENRE_COLORS["文章"]));
  assert.equal(glyphFromSvg(svg), G);
  assert.equal(glyphFromSvg(skillIconSvg("運営・仕組み", G, true, 32)), G);
});

test("ChatGPT 用の openai.yaml", () => {
  const y = openaiYaml({ title: "シアニンの入口", purpose: "依頼に合う \"レシピ\" を探す", genre: "運営・仕組み" });
  assert.match(y, /display_name: "シアニンの入口"/);
  assert.match(y, /icon_small: "\.\/assets\/icon-small\.svg"/);
  assert.match(y, /brand_color: "#52525b"/);
  assert.match(y, /\\"レシピ\\"/);
});
