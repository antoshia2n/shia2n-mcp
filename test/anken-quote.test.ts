import test from "node:test";
import assert from "node:assert/strict";
import { pickQuote } from "../src/anken-quote.ts";

// 10/15 の議事録の形（1 回分が 1 つの発言）。先頭の行や最初に拾った言葉ではなく、やることに当たる行が出ること
const minutes = [
  "2026/10/15",
  "1. YouTube関連",
  "   2. 今後の5本の分析",
  "      1. 再作成の3本のチェック",
  "   4. また、新しい関連チャンネルとかも調べて、界隈の流れを知っておくべき",
  "3. 3話オファー関連",
  "   2. LINE配信通数が不足してる",
  "      1. 1週間ほどで尽きそう",
].join("\n");

test("議事録：やることの名前にいちばん近い行を選ぶ", () => {
  const tags = ["再作成の3本のチェック"];
  assert.equal(pickQuote({ body: minutes, title: "LINE 配信通数の不足に、プランを上げるかを先生に決めてもらう", tagQuotes: tags }), "2. LINE配信通数が不足してる");
  assert.equal(pickQuote({ body: minutes, title: "新しい関連チャンネルを調べて界隈の流れを共有", tagQuotes: tags }), "4. また、新しい関連チャンネルとかも調べて、界隈の流れを知っておくべき");
  assert.equal(pickQuote({ body: minutes, title: "作り直す3本をチェックする", tagQuotes: tags }), "再作成の3本のチェック");
});

test("示された言葉があればそのまま使う", () => {
  assert.equal(pickQuote({ body: minutes, title: "何か", given: "  2. 今後の5本の分析 " }), "2. 今後の5本の分析");
});

test("重なりが無ければ、拾った言葉 → 先頭の行の順", () => {
  assert.equal(pickQuote({ body: minutes, title: "ぜんぜん別", tagQuotes: ["再作成の3本のチェック"] }), "再作成の3本のチェック");
  assert.equal(pickQuote({ body: minutes, title: "ぜんぜん別" }), "2026/10/15");
});

test("1 行の発言（LINE）はこれまでどおり：拾った言葉か、本文の先頭 120 字", () => {
  assert.equal(pickQuote({ body: "OKです！", title: "分析する", tagQuotes: ["OKです"] }), "OKです");
  const long = "あ".repeat(200);
  assert.equal(pickQuote({ body: long, title: "x" }), "あ".repeat(120));
});
