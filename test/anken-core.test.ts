import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseMinutes, maskSecrets, withHashes } from "../src/anken-core.ts";

// 案件くん（anken リポジトリ src/core/parse.js）と同じ中身であることの試し
test("LINE の履歴：名前に空白・改行・同じ時刻の画像", async () => {
  const t = "[LINE] テストとのトーク履歴\n保存日時：2026/10/21 19:00\n\n2026.10.20 火曜日\n10:12\tクライアントA\tおはよう\n10:15\tNAOKI TAKEBAYASHI\t\"数字は\nシートに\"\n2026.10.21 水曜日\n09:05\tNAOKI TAKEBAYASHI\t画像\n09:05\tNAOKI TAKEBAYASHI\t画像";
  const r = parseLine(t, { self: ["NAOKI TAKEBAYASHI"] });
  assert.equal(r.title, "テスト");
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[1].who, "NAOKI TAKEBAYASHI");
  assert.equal(r.messages[1].body, "数字は\nシートに");
  const h = await withHashes(r.messages);
  assert.equal(new Set(h.map((m) => m.hash)).size, 4);
});

test("伏せ字と議事録", () => {
  const m = maskSecrets("ID：a@b.jp\nパスワード：x1\nURL：https://e.com");
  assert.equal(m.count, 2);
  assert.ok(m.text.includes("https://e.com"));
  const r = parseMinutes("ログイン\nID：a\n\n■ 2026/10/15 定例\n・台本\n■ 10/8\n・3話", { today: "2026-10-21" });
  assert.deepEqual(r.messages.map((x: any) => x.day), ["2026-10-21", "2026-10-15", "2026-10-08"]);
});

test("名前だけの行・ラベルの無いメールアドレスと電話番号（2026-10-21 レビュー）", () => {
  const t = ["2026.10.04 土曜日", "18:19 NAOKI TAKEBAYASHI お待たせしました！", "よろしくお願いしますー！",
    "2026.10.05 月曜日", "10:49 るみ先生【しあらぼ】 ", "https://docs.google.com/document/d/x/edit",
    "10:51 るみ先生【しあらぼ】 音声", "12:18 NAOKI TAKEBAYASHI 了解です", "12:19 るみ先生【しあらぼ】 はい"].join("\n");
  const r = parseLine(t, { self: ["NAOKI TAKEBAYASHI"] });
  const m = r.messages.find((x: any) => x.time === "10:49");
  assert.equal(m.day, "2026-10-05");
  assert.equal(m.body, "https://docs.google.com/document/d/x/edit");
  assert.ok(!r.messages[0].body.includes("10:49"));
  const a = maskSecrets("申込者 joey.wagner68@outlook.com さん\n電話 090-1234-5678");
  assert.equal(a.count, 2);
  assert.ok(!/joey|1234-5678/.test(a.text));
  assert.equal(maskSecrets("ミーティングID: 929 784 4714\nhttps://www.youtube.com/@channel-x").count, 0);
});
