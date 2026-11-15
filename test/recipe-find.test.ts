// v1.110.0：入口（依頼からレシピと補強のスキルを探す）
import test from "node:test";
import assert from "node:assert/strict";
import { findRecipes, grams } from "../src/recipe-find-core.js";

const K = (name: string, title: string, purpose: string, category: string[], media: string[], extra: Partial<{ conflicts: string[]; genre: string }> = {}) =>
  ({ name, title, purpose, description: purpose, genre: extra.genre || null, category, media, conflicts: extra.conflicts || [], kind: null });
const skills = [
  K("shia2n-zukai-10sen", "〇〇10選図解", "大きな題と番号付きのカードで並べる「〇〇10選」図解を作る", ["スタイル"], ["X"]),
  K("shia2n-koboke", "小ボケコメント", "図解のイラストの横に置く小ボケのひと言を、大喜利の手順で作る", ["コメント"], ["X"], { conflicts: ["shia2n-zukai-kozo"] }),
  K("shia2n-zukai-kozo", "構造図解（4枚）", "主体が見える手書きの構造図解を、正方形4枚で作る", ["スタイル"], ["X"], { conflicts: ["shia2n-koboke"] }),
  K("shia2n-x-review", "X アルゴリズム逆算レビュー", "X の表示の仕組みから逆算して、出す前の図解・ポストをレビューする", ["レビュー"], ["X"]),
  K("x-thread-pipeline", "X スレッド制作", "X のスレッド投稿を、見本の分析から予約投稿まで作る", ["手順"], ["X"]),
  K("notion-write-guard", "Notion 書き込みの事故防止", "Notion へ書くときに入らない事故を防ぐ", ["ガード"], []),
];
const recipes = [
  { name: "shia2n-10sen-koboke", title: "10選×小ボケ（強）", purpose: "人物のイラストと小ボケで読ませる「〇〇10選」図解を作る", uses: [{ skill: "shia2n-zukai-10sen" }, { skill: "shia2n-koboke" }], flow: [] },
  { name: "shia2n-kozo-standard", title: "構造図解（標準）", purpose: "引用ポストに添える、主体が見える構造図解（正方形4枚）を作る", uses: [{ skill: "shia2n-zukai-kozo" }], flow: [] },
];

test("2 文字ずつの単位と英数字の語", () => {
  const g = grams("X の図解を10選で");
  assert.ok(g.has("図解") && g.has("10") && !g.has("を1"));
  assert.ok(grams("chatgpt で").has("chatgpt"));
});

test("10選の依頼には 10選×小ボケ を勧め、レビューを補強に出す（入っているスキルは出さない）", () => {
  const r = findRecipes("副業初心者がやりがちなミス10選の図解を作って", recipes, skills);
  assert.equal(r.おすすめ[0].name, "shia2n-10sen-koboke");
  assert.ok(r.補強の候補.some((x) => x.name === "shia2n-x-review"));
  assert.ok(!r.補強の候補.some((x) => x.name === "shia2n-koboke" || x.name === "shia2n-zukai-10sen"));
  assert.match(r.聞き方, /「10選×小ボケ（強）」のレシピを使います/);
});

test("構造図解の依頼では、ぶつかる小ボケを補強に出さない。ガードも出さない", () => {
  const r = findRecipes("引用ポストに添える構造図解を作りたい。誰が何をするかを見せたい", recipes, skills);
  assert.equal(r.おすすめ[0].name, "shia2n-kozo-standard");
  assert.ok(!r.補強の候補.some((x) => x.name === "shia2n-koboke"));
  assert.ok(!r.補強の候補.some((x) => x.name === "notion-write-guard"));
});

test("合うレシピが無ければ、スキルだけを返す", () => {
  const r = findRecipes("スレッド投稿を予約まで作って", recipes, skills);
  assert.equal(r.おすすめ.length, 0);
  assert.equal(r.スキルだけ[0].name, "x-thread-pipeline");
  assert.match(r.聞き方, /スキル「X スレッド制作」で進めますか/);
});

test("何も当たらなければ聞き返す", () => {
  const r = findRecipes("晩ごはんの献立", recipes, skills);
  assert.equal(r.おすすめ.length + r.スキルだけ.length, 0);
  assert.match(r.聞き方, /もう少し教えてください/);
});
