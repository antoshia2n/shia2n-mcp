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
