// v1.125.0：マネージャーくんの計算。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { aiOf, chatOut, chatUrl, checkPin, checkUpdate, firstState, jstShort, normState, parseChatRef, parsePinRef, pickChats, pinNo, pinOut } from "../src/manager-core.js";

test("状態：4 つの値とよくある書き方を受け、ほかは断る", () => {
  assert.equal(normState("判断待ち"), "判断待ち");
  assert.equal(normState("確認待ち"), "判断待ち");
  assert.equal(normState("done"), "閉じた");
  assert.equal(normState("完了"), "閉じた");
  assert.equal(normState("保留"), "寝かせ中");
  assert.equal(normState("In Progress"), "進行中");
  assert.equal(normState("やる気"), null);
  assert.equal(normState(""), null);
});

test("立てるとき：GPT は gpt・ほかは claude。予約タスクは最初から閉じた", () => {
  assert.equal(aiOf("GPT"), "gpt");
  assert.equal(aiOf("Claude Code"), "claude");
  assert.equal(aiOf("claude.ai"), "claude");
  assert.equal(firstState("予約タスク"), "閉じた");
  assert.equal(firstState("claude.ai"), "進行中");
});

test("チャットの指し方：番号・#番号・住所・名前の言葉", () => {
  assert.deepEqual(parseChatRef("12"), { no: 12 });
  assert.deepEqual(parseChatRef("#12"), { no: 12 });
  assert.deepEqual(parseChatRef("チャット12"), { no: 12 });
  assert.deepEqual(parseChatRef("ｃ１２"), { no: 12 }); // 全角も
  assert.deepEqual(parseChatRef(7), { no: 7 });
  assert.deepEqual(parseChatRef("https://claude.ai/chat/abc"), { url: "https://claude.ai/chat/abc" });
  assert.deepEqual(parseChatRef(" 統括  起動 "), { words: ["統括", "起動"] });
  assert.equal(parseChatRef("0"), null);
  assert.equal(parseChatRef(""), null);
});

test("ピンの指し方：12#3・12-3・12のピン3・ピンの番号だけ", () => {
  assert.deepEqual(parsePinRef("12#3"), { chat: "12", n: 3 });
  assert.deepEqual(parsePinRef("12-3"), { chat: "12", n: 3 });
  assert.deepEqual(parsePinRef("12のピン3"), { chat: "12", n: 3 });
  assert.deepEqual(parsePinRef("チャット12 ピン3"), { chat: "12", n: 3 });
  assert.deepEqual(parsePinRef("１２＃３"), { chat: "12", n: 3 });
  assert.deepEqual(parsePinRef("#3"), { chat: null, n: 3 });
  assert.deepEqual(parsePinRef("ピン3"), { chat: null, n: 3 });
  assert.equal(parsePinRef("統括のピン"), null);
  assert.equal(pinNo("3"), 3);
  assert.equal(pinNo(4), 4);
  assert.equal(pinNo("12#3"), null);
  assert.equal(pinNo("abc"), null);
});

test("ピン：題は空白をつめて 120 字まで・全文はそのまま・空は断る", () => {
  const a = checkPin("  設計の\n確定案 ", "# 見出し\n\n  本文  ");
  assert.ok(a.ok);
  if (a.ok) { assert.equal(a.title, "設計の 確定案"); assert.equal(a.body, "# 見出し\n\n  本文  "); }
  assert.equal(checkPin("", "x").ok, false);
  assert.equal(checkPin("題", "   ").ok, false);
  assert.equal(checkPin("あ".repeat(121), "x").ok, false);
  assert.equal(checkPin("題", "あ".repeat(200001)).ok, false);
});

test("書き直し：状態を言い換え・住所は https だけ・空の住所は消す・何も無ければ断る", () => {
  const a = checkUpdate({ state: "確認待ち", doing: " どちらの案で進めるか " });
  assert.deepEqual(a, { ok: true, patch: { state: "判断待ち", doing: "どちらの案で進めるか" } });
  assert.equal(checkUpdate({ state: "なぞ" }).ok, false);
  assert.equal(checkUpdate({ url: "javascript:alert(1)" }).ok, false);
  assert.deepEqual(checkUpdate({ url: "" }), { ok: true, patch: { url: null } });
  assert.equal(checkUpdate({}).ok, false);
  assert.equal(checkUpdate({ doing: "あ".repeat(201) }).ok, false);
  assert.deepEqual(chatUrl("  "), { ok: true, url: null });
});

test("名前で選ぶ：全部の言葉を含み、ピンの数が足りるものを、最後に触った順", () => {
  const rows = [
    { no: 1, name: "統括起動（日曜）", role: "統括", doing: "", pin_count: 5, touched_at: "2026-11-20T10:00:00Z" },
    { no: 2, name: "GPT・Claude のセッション管理の壁打ち", role: "統括", doing: "", pin_count: 2, touched_at: "2026-11-21T10:00:00Z" },
    { no: 3, name: "マネージャーくん 1便目", role: "開発部", doing: "", pin_count: 9, touched_at: "2026-11-21T12:00:00Z" },
  ];
  assert.deepEqual(pickChats(rows, ["統括"]).map((r) => r.no), [2, 1]);
  assert.deepEqual(pickChats(rows, ["統括"], 3).map((r) => r.no), [1]); // ピン 3 を持つのは 1 だけ
  assert.deepEqual(pickChats(rows, ["マネージャー", "1便目"]).map((r) => r.no), [3]);
  assert.deepEqual(pickChats(rows, ["なし"]), []);
});

test("返す形：日本時間・ピンの参照は 12#3", () => {
  assert.equal(jstShort("2026-11-21T11:20:24Z"), "2026-11-21 20:20");
  assert.equal(jstShort("x"), "");
  const c = chatOut({ no: 12, name: "n", ai: "gpt", state: "判断待ち", doing: "d", url: null, role: "統括", pin_count: 3, touched_at: "2026-11-21T00:00:00Z", created_at: "2026-11-20T15:00:00Z" });
  assert.equal(c.番号, 12); assert.equal(c.住所, null); assert.equal(c.作った, "2026-11-21 00:00");
  const p = pinOut({ chat_no: 12, n: 3, title: "t", body: "本文", created_at: "2026-11-21T00:00:00Z" }, { name: "n", url: "https://x" }, true);
  assert.equal(p.ピン, "12#3"); assert.equal(p.全文, "本文"); assert.equal(p.字数, 2); assert.equal(p.チャットの住所, "https://x");
  assert.equal("全文" in pinOut({ chat_no: 1, n: 1, title: "t", body: "b" }), false);
});
