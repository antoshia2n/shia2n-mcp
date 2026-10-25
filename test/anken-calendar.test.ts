// v1.42.0：案件くんの次の MTG を予定表から。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { eventsOnDays, eventsOnDay } from "../src/ical-day.js";
import { isCaseMeeting, pickNext, whenText, meetingsFor } from "../src/anken-calendar.js";

const cal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap(e => ["BEGIN:VEVENT", ...e.trim().split("\n").map(l => l.trim()), "END:VEVENT"]), "END:VCALENDAR"].join("\r\n") + "\r\n";
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));

// 2026-10-25 の実物に合わせた形：毎週木曜 13 時の「るーみん定例」、10/29 の回だけ 15 時へ動かした。ほかに「るーみんグルコン」と別の案件の予定
const ICS = cal(
  "UID:rumin\nSUMMARY:るーみん定例\nDTSTART;TZID=Asia/Tokyo:20260910T130000\nDTEND;TZID=Asia/Tokyo:20260910T140000\nRRULE:FREQ=WEEKLY;BYDAY=TH",
  "UID:rumin\nRECURRENCE-ID;TZID=Asia/Tokyo:20261029T130000\nSUMMARY:るーみん定例\nDTSTART;TZID=Asia/Tokyo:20261029T150000\nDTEND;TZID=Asia/Tokyo:20261029T160000",
  "UID:gc\nSUMMARY:るーみんグルコン\nDTSTART;TZID=Asia/Tokyo:20261027T120000\nDTEND;TZID=Asia/Tokyo:20261027T133000",
  "UID:ruri\nSUMMARY:るりさん＠在庫管理くん運用\nDTSTART;TZID=Asia/Tokyo:20261027T113000\nDTEND;TZID=Asia/Tokyo:20261027T120000",
);

test("当てる決まり：案件名と「定例」の両方。全角半角・空白の違いは同じ。グルコンや名前の違う予定は当たらない", () => {
  assert.equal(isCaseMeeting("るーみん", "るーみん定例"), true);
  assert.equal(isCaseMeeting("るーみん", "るーみん 定例 MTG"), true);
  assert.equal(isCaseMeeting("ABC", "ａｂｃ定例"), true);
  assert.equal(isCaseMeeting("るーみん", "るーみんグルコン"), false);
  assert.equal(isCaseMeeting("おかぜり", "るりさん＠在庫管理くん運用"), false);
  assert.equal(isCaseMeeting("", "定例"), false);
});

test("何日分を 1 回で読む：題名で絞り、動かした回は動かした時刻だけ出る（元の 13 時は出ない）", async () => {
  const r = await eventsOnDays([ICS], days("2026-10-25", 14), t => isCaseMeeting("るーみん", t));
  assert.deepEqual(r.events.map(e => e.title + " " + e.start), [
    "るーみん定例 2026-10-29T15:00:00+09:00",
    "るーみん定例 2026-11-05T13:00:00+09:00",
  ]);
  assert.equal(r.scanned, 4);
});

test("何日分を読む形と 1 日の形は、同じ日に同じ予定を返す", async () => {
  const one = await eventsOnDay([ICS], "2026-10-29");
  const many = await eventsOnDays([ICS], ["2026-10-29"], () => true);
  assert.deepEqual(many.events, one.events);
  await assert.rejects(eventsOnDays([ICS], days("2026-01-01", 93), () => true), /92 日まで/);
});

test("次の回：今より後に終わる回のうちいちばん早いもの。書き方は推定と同じ", async () => {
  const r = await eventsOnDays([ICS], days("2026-10-22", 21), t => isCaseMeeting("るーみん", t));
  const at = (iso: string) => Date.parse(iso);
  assert.equal(pickNext(r.events, at("2026-10-25T17:00:00+09:00"))?.start, "2026-10-29T15:00:00+09:00");
  assert.equal(pickNext(r.events, at("2026-10-22T13:30:00+09:00"))?.start, "2026-10-22T13:00:00+09:00"); // 開催中はその回
  assert.equal(pickNext(r.events, at("2026-10-29T16:00:00+09:00"))?.start, "2026-11-05T13:00:00+09:00");
  assert.equal(whenText(r.events.find(e => e.start.startsWith("2026-10-29"))!), "2026-10-29（木）15時");
  assert.equal(whenText({ uid: "x", title: "t", start: "2026-11-02T10:30:00+09:00", end: "2026-11-02T11:00:00+09:00", all_day: false, time: "" }), "2026-11-02（月）10時30分");
  assert.equal(whenText({ uid: "x", title: "t", start: "2026-11-03", end: "2026-11-04", all_day: true, time: "終日" }), "2026-11-03（火）");
});

test("案件ごと：見つかった案件だけ返す（見つからない案件は推定のまま使う側へ）", async () => {
  const r = await eventsOnDays([ICS], days("2026-10-25", 42), t => ["るーみん", "おかぜり"].some(n => isCaseMeeting(n, t)));
  const m = meetingsFor(["るーみん", "おかぜり"], r.events.map(e => ({ ...e, calendar: "メイン" })), Date.parse("2026-10-25T17:00:00+09:00"));
  assert.deepEqual(m.get("るーみん"), { when: "2026-10-29（木）15時", day: "2026-10-29", title: "るーみん定例", start: "2026-10-29T15:00:00+09:00", calendar: "メイン" });
  assert.equal(m.has("おかぜり"), false);
});
