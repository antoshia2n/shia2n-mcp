// v1.45.0：AI の利用ログの計算。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { checkAdd, jstRange, normWhere, summarize, toJst, jstDate, todayJst } from "../src/ai-log-core.js";

test("場所：4 つの値と、よくある書き方を受け付ける。ほかは断る", () => {
  assert.equal(normWhere("claude.ai"), "claude.ai");
  assert.equal(normWhere("Claude Code"), "Claude Code");
  assert.equal(normWhere("claude_code"), "Claude Code");
  assert.equal(normWhere("ChatGPT"), "GPT");
  assert.equal(normWhere("予約タスク"), "予約タスク");
  assert.equal(normWhere("slack"), null);
  assert.equal(normWhere(""), null);
});

test("書く前の確かめ：決まった役割は注意なし・一覧に無い役割は残して注意・空と長すぎは断る", () => {
  const a = checkAdd({ role: " 統括 ", where: "claude.ai", title: "  週間 \n レポート " });
  assert.ok(a.ok);
  if (a.ok) { assert.deepEqual(a.row, { role: "統括", surface: "claude.ai", title: "週間 レポート" }); assert.equal(a.warnings.length, 0); }
  const b = checkAdd({ role: "統括部", where: "gpt", title: "x" });
  assert.ok(b.ok);
  if (b.ok) { assert.equal(b.row.surface, "GPT"); assert.equal(b.warnings.length, 1); }
  assert.equal(checkAdd({ role: "", where: "gpt", title: "x" }).ok, false);
  assert.equal(checkAdd({ role: "統括", where: "slack", title: "x" }).ok, false);
  assert.equal(checkAdd({ role: "統括", where: "gpt", title: " " }).ok, false);
  assert.equal(checkAdd({ role: "統括", where: "gpt", title: "あ".repeat(201) }).ok, false);
  assert.equal(checkAdd({ role: "あ".repeat(31), where: "gpt", title: "x" }).ok, false);
});

test("時刻：UTC を日本時間に直す。日本時間の 0 時をまたぐと日付が進む", () => {
  assert.equal(toJst("2026-10-25T15:30:00.123+00:00"), "2026-10-26T00:30:00+09:00");
  assert.equal(jstDate("2026-10-25T14:59:59Z"), "2026-10-25");
  assert.equal(jstDate("2026-10-25T15:00:00Z"), "2026-10-26");
  assert.equal(todayJst(new Date("2026-10-25T15:00:00Z")), "2026-10-26");
});

test("期間：省略は今日 1 日。日本時間の 0 時〜翌 0 時を UTC で引く。31 日まで・逆順と形の誤りは断る", () => {
  const now = new Date("2026-10-26T00:35:00Z");
  const r = jstRange(undefined, undefined, now);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.from, "2026-10-26"); assert.equal(r.to, "2026-10-26");
    assert.deepEqual(r.days, ["2026-10-26"]);
    assert.equal(r.startIso, "2026-10-25T15:00:00.000Z");
    assert.equal(r.endIso, "2026-10-26T15:00:00.000Z");
  }
  const w = jstRange("2026-10-01", "2026-10-31");
  assert.ok(w.ok); if (w.ok) assert.equal(w.days.length, 31);
  assert.equal(jstRange("2026-10-01", "2026-11-01").ok, false);
  assert.equal(jstRange("2026-10-20", "2026-10-19").ok, false);
  assert.equal(jstRange("2026/10/20").ok, false);
  assert.equal(jstRange("2026-02-30").ok, false);
});

test("まとめ：古い順の一覧・役割ごと・場所ごと・日ごと（0 回の日も並ぶ）", () => {
  const rows = [
    { at: "2026-10-25T23:00:00Z", role: "開発部", surface: "claude.ai", title: "ログの道具" },   // 10/26 08:00
    { at: "2026-10-25T14:00:00Z", role: "統括", surface: "claude.ai", title: "朝の確認" },       // 10/25 23:00
    { at: "2026-10-25T16:00:00Z", role: "統括", surface: "予約タスク", title: "日報" },           // 10/26 01:00
  ];
  const s = summarize(rows, ["2026-10-24", "2026-10-25", "2026-10-26"]);
  assert.equal(s.件数, 3);
  assert.deepEqual(s.役割ごと, { 統括: 2, 開発部: 1 });
  assert.deepEqual(s.場所ごと, { "claude.ai": 2, 予約タスク: 1 });
  assert.deepEqual(s.日ごと, [
    { 日: "2026-10-24", 回数: 0, 役割ごと: {} },
    { 日: "2026-10-25", 回数: 1, 役割ごと: { 統括: 1 } },
    { 日: "2026-10-26", 回数: 2, 役割ごと: { 統括: 1, 開発部: 1 } },
  ]);
  assert.deepEqual(s.一覧.map(x => x.時刻), ["2026-10-25T23:00:00+09:00", "2026-10-26T01:00:00+09:00", "2026-10-26T08:00:00+09:00"]);
  assert.deepEqual(summarize([], ["2026-10-26"]), { 件数: 0, 役割ごと: {}, 場所ごと: {}, 日ごと: [{ 日: "2026-10-26", 回数: 0, 役割ごと: {} }], 一覧: [] });
});
