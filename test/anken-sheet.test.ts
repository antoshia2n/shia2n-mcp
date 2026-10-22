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

import { readTab } from "../src/anken-sheet.ts";
import { parseAddBody } from "../src/anken-sheet.ts";

const C = (text: string, ...links: string[]) => ({ text, links });

test("読む：見出しのあるタブ（チップのリンク・リンクの無い行・名前の無い行）", () => {
  const t = readTab("YouTube", [
    [C(""), C("名前"), C("リンク"), C("詳細")],
    [C(""), C(""), C(""), C("")],
    [C(""), C(""), C("YouTube 台本", "https://docs.google.com/document/d/1FjXTgOQg2jeaAeTXNza7BKsbOKxEzUNBz0abc/edit"), C("・るーみんが使ってる台本")],
    [C(""), C("ABテスト用GPT"), C(""), C("サムネとタイトル（2案）")],
    [C(""), C("10/22公開"), C("https://youtu.be/ZpWft_0lXQc"), C("YouTube・10/22")],
  ]);
  assert.deepEqual(t.rows.map((r) => [r.row, r.name, r.url]), [
    [3, "YouTube 台本", "https://docs.google.com/document/d/1FjXTgOQg2jeaAeTXNza7BKsbOKxEzUNBz0abc/edit"],
    [4, "ABテスト用GPT", null],
    [5, "10/22公開", "https://youtu.be/ZpWft_0lXQc"],
  ]);
});

test("読む：ジャンルの区切り行は下へ引き継ぐ。見出しの無いタブは B の先頭が名前", () => {
  const u = readTab("UTAGE", [
    [C("ジャンル"), C("名称"), C("詳細"), C("リンク")],
    [C("イベント・リマインダ")],
    [C(""), C("リマインダーのLINE"), C("ほか・10/20"), C("https://lin.ee/tWl8PHS")],
    [C("決済・申込"), C("本講座決済①"), C("UTAGE・10/19"), C("https://utage-system.com/p/geDyQMfbxrPL")],
  ]);
  assert.deepEqual(u.rows.map((r) => [r.name, r.group]), [["リマインダーのLINE", "イベント・リマインダ"], ["本講座決済①", "決済・申込"]]);
  const k = readTab("タスク", [
    [C(""), C(""), C("るーみん_定例MTG議事録", "https://docs.google.com/document/d/1vWaxR54pDSHgDYXStAe5QXFqiU8Y6pHcWOxx/edit")],
    [C(""), C("にんけん情報共有スプシ｜シート・10/14・運営グループ"), C("https://docs.google.com/spreadsheets/d/1CD6xkZjE53s40y-I2reqIJC2CAlmZOxx/edit")],
  ]);
  assert.deepEqual(k.rows.map((r) => [r.row, r.name, r.detail]), [[1, "るーみん_定例MTG議事録", ""], [2, "にんけん情報共有スプシ", "シート・10/14・運営グループ"]]);
});

test("画面から足す中身の確かめ：余計な欄・21 件以上・URL でないものは断る", () => {
  const ok = parseAddBody(JSON.stringify({ case_id: "81eead51-040d-4ef7-a93b-f3e3131eeb22", tab: "YouTube", items: [{ name: " a ", url: "https://youtu.be/x" }] }));
  assert.equal(ok.items[0].name, "a");
  assert.throws(() => parseAddBody(JSON.stringify({ case_id: "81eead51-040d", tab: "x", items: [], extra: 1 })), /invalid_body/);
  assert.throws(() => parseAddBody(JSON.stringify({ case_id: "81eead51-040d", tab: "x", items: Array(21).fill({ name: "a", url: "https://a.jp" }) })), /invalid_items/);
  assert.throws(() => parseAddBody(JSON.stringify({ case_id: "81eead51-040d", tab: "x", items: [{ name: "a", url: "javascript:alert(1)" }] })), /invalid_item_url/);
});
