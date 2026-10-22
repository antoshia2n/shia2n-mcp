import test from "node:test";
import assert from "node:assert/strict";
import { planRows, findColumns, linkKey, NEW_TAB_HEADER } from "../src/anken-sheet.ts";

// るーみん案件データ管理の実物の形（10/22 に読んだもの）
const youtube = [
  ["", "名前", "リンク", "詳細"],
  ["", "", "", ""],
  ["", "", "YouTube 台本 https://docs.google.com/document/d/1FjXTgOQg2jeaAeTXNza7BKsbOKxEzUNBz0abc/edit", "・るーみんが使ってる台本"],
  ["", "YouTube分析まとめ", "https://chatgpt.com/c/6acf5770-4450-83ec-addf-9cbd191c00d2", ""],
];
const utage = [["ジャンル", "名称", "詳細", "リンク"], [], [], [], [], ["イベント・リマインダ"]];
const tasks = [["", "", "るーみん_定例MTG議事録"], ["", "毎週の定例MTG", "るーみん_定例MTG議事録"]];

test("見出しで列を見分ける（名前・名称／見出しなし）", () => {
  assert.deepEqual(findColumns(youtube), { headerRow: 1, name: 1, link: 2, detail: 3, group: null });
  assert.deepEqual(findColumns(utage), { headerRow: 1, name: 1, link: 3, detail: 2, group: 0 });
  assert.deepEqual(findColumns(tasks), { headerRow: 0, name: null, link: 2, detail: 1, group: null });
});

test("同じリンクは足さない（Google は /edit や ?usp= の違いを見ない）", () => {
  const p = planRows(youtube, [
    { name: "YouTube 台本", url: "https://docs.google.com/document/d/1FjXTgOQg2jeaAeTXNza7BKsbOKxEzUNBz0abc/edit?usp=sharing" },
    { name: "新しい台本", url: "https://docs.google.com/document/d/1NEWdocNEWdocNEWdocNEWdoc/edit", detail: "ドキュメント・10/22" },
    { name: "新しい台本（重複）", url: "https://docs.google.com/document/d/1NEWdocNEWdocNEWdocNEWdoc/view" },
  ]);
  assert.equal(p.rows.length, 1);
  assert.equal(p.skipped.length, 2);
  assert.equal(p.startRow, 5);
  assert.deepEqual(p.rows[0], ["", "'新しい台本", "https://docs.google.com/document/d/1NEWdocNEWdocNEWdocNEWdoc/edit", "'ドキュメント・10/22"]);
});

test("UTAGE のタブ：最後の行（6 行目）の下から、名称・詳細・リンクの列へ", () => {
  const p = planRows(utage, [{ name: "本講座決済①", url: "https://utage-system.com/p/geDyQMfbxrPL", detail: "UTAGE・10/19", group: "決済" }]);
  assert.equal(p.startRow, 7);
  assert.deepEqual(p.rows[0], ["'決済", "'本講座決済①", "'UTAGE・10/19", "https://utage-system.com/p/geDyQMfbxrPL"]);
});

test("見出しの無いタブ：B＝名前と詳細、C＝リンク", () => {
  const p = planRows(tasks, [{ name: "にんけん情報共有スプシ", url: "https://docs.google.com/spreadsheets/d/1CD6xkZjE53s40y-I2reqIJC2CAlmZOxx/edit", detail: "シート・10/14" }]);
  assert.equal(p.startRow, 3);
  assert.deepEqual(p.rows[0], ["", "'にんけん情報共有スプシ｜シート・10/14", "https://docs.google.com/spreadsheets/d/1CD6xkZjE53s40y-I2reqIJC2CAlmZOxx/edit"]);
});

test("新しいタブは見出しだけの状態から 2 行目に入る", () => {
  const p = planRows([NEW_TAB_HEADER], [{ name: "応援ページ", url: "https://utage-system.com/p/Y0KmFxyAxjRh" }]);
  assert.equal(p.startRow, 2);
  assert.equal(linkKey("https://drive.google.com/drive/folders/1U8iusLUKUNXQULBxMWxcR5jLUWlfAP?usp=x"), "g:1U8iusLUKUNXQULBxMWxcR5jLUWlfAP");
});
