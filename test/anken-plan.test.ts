import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePeriods, periodId, extractLinks, keyOf } from "../src/anken-plan.ts";

test("予定の出し直し：Naoki のもの・消したものは残し、同じものは出し直さない（2026-10-22）", async () => {
  const naoki = { id: await periodId("3話オファー", "2026-10-20"), title: "3話オファー", start: "2026-10-20", end: "2026-10-26", kind: "offer" as const, by: "naoki" as const };
  const hidden = { id: await periodId("撮影", "2026-10-25"), title: "撮影", start: "2026-10-25", end: "2026-10-25", kind: "event" as const, by: "ai" as const, hidden: true };
  const oldAi = { id: "x", title: "古い予定", start: "2026-10-01", end: "2026-10-01", kind: "other" as const, by: "ai" as const };
  const r = await mergePeriods([naoki, hidden, oldAi], [
    { title: "3話オファー", start: "2026-10-20", end: "2026-10-27", kind: "offer" },
    { title: "撮影", start: "2026-10-25", end: "2026-10-25", kind: "event" },
    { title: "本講座の販売", start: "2026-11-01", end: "2026-10-01", kind: "offer" },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 2);
  assert.ok(!r.periods.some((p) => p.title === "古い予定"));
  const sale = r.periods.find((p) => p.title === "本講座の販売")!;
  assert.equal(sale.end, "2026-11-01"); // 終わりが始まりより前なら始まりの日にする
  assert.equal(r.periods.find((p) => p.title === "3話オファー")!.end, "2026-10-26"); // Naoki の直しが残る
});

test("リンクの鍵と拾い方（anken の links.js と同じ）", () => {
  assert.equal(keyOf("https://docs.google.com/spreadsheets/d/abc_DEF-1/edit#gid=0"), "g:abc_DEF-1");
  assert.equal(keyOf("https://utage-system.com/p/SDUqxOpmYIHq/"), "https://utage-system.com/p/SDUqxOpmYIHq");
  const rows = extractLinks([
    { day: "2026-10-01", at_time: "10:00", who: "A", body: "サンクスページ\nhttps://utage-system.com/p/aaa" },
    { day: "2026-10-05", at_time: "10:00", who: "B", body: "台本はこちら https://docs.google.com/document/d/zzz/edit" },
    { day: "2026-10-06", at_time: "10:00", who: "B", body: "https://docs.google.com/document/d/zzz/edit?tab=t.0" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "g:zzz");
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].name, "台本はこちら");
  assert.equal(rows[1].name, "サンクスページ");
});

test("案件チャットが入れた予定は AI の出し直しで消えない（2026-10-22）", async () => {
  const chat = { id: await periodId("大分合宿", "2026-10-30"), title: "大分合宿", start: "2026-10-30", end: "2026-10-31", kind: "event" as const, by: "chat" as const };
  const r = await mergePeriods([chat], [{ title: "熊本セミナー", start: "2026-11-04", end: "2026-11-04", kind: "event" }]);
  assert.ok(r.periods.some((p) => p.title === "大分合宿"));
  assert.equal(r.added, 1);
});
