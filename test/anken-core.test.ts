import test from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseMinutes, maskSecrets, maskMessages, withHashes } from "../src/anken-core.ts";

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

test("伏せ字の抜けと \" の取りこぼし（2026-10-22 おかぜり）", () => {
  const a = maskSecrets("Xアカウント  \nID  \nuser01@example.com  \npass abcdefgh");
  assert.ok(!/user01|abcdefgh/.test(a.text));
  const c = maskSecrets("pk_live_abcdefghij1234567890\nrk_live_ZYXWVUTSRQ0987654321");
  assert.equal(c.count, 2);
  assert.equal(maskSecrets("ID\nありがとうございます").count, 0);
  const s = maskMessages([
    { day: "2026-01-01", time: "17:20", who: "A", body: "ログインIDはこれです\nuser@example.com" },
    { day: "2026-01-01", time: "17:29", who: "B", body: "abcd1234!!" },
    { day: "2026-01-01", time: "18:00", who: "A", body: "差し込みは\n%sei_mei%\nで入ります（メールアドレスの欄）" },
  ]);
  assert.equal(s.messages[1].body, "＊＊＊（伏せた）");
  assert.ok(s.messages[2].body.includes("%sei_mei%"));
  const q = parseLine("2025.05.03 土曜日\n11:30 岡芹 \"せどり\"のワードは省きました！\n12:16 NAOKI TAKEBAYASHI ありがとう！\n2025.05.05 月曜日\n00:08 岡芹 お疲れ様です！", { self: ["NAOKI TAKEBAYASHI"] });
  assert.equal(q.messages.length, 3);
});

test("名前の推定で @All を名前に含めない（2026-10-22 おかぜりのグループ）", () => {
  const r = parseLine("2026.10.01 木曜日\n10:00 Ruriko Koizumi @All 明日の件です\n10:05 Ruriko Koizumi よろしくお願いします\n10:06 Ruriko Koizumi @All 資料を送ります\n10:07 Ruriko Koizumi @All 締切は金曜です\n10:08 Ruriko Koizumi @All 確認お願いします", { self: ["NAOKI TAKEBAYASHI"] });
  assert.ok(r.messages.every((m: any) => m.who === "Ruriko Koizumi"));
});
