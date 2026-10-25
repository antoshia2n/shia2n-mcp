// v1.15.0：その日の記録。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { eventsOnDay, parseRule } from "../src/ical-day.js";
import { splitTasks, calendarsOf, buildDayRecord, firestoreSafe, groupsMapOf, fillGroups } from "../src/haaku-day-record.js";
import { dateColumnOf, ruleFkOf } from "../src/kiroku-read.js";
import { tokyoNowIso } from "../src/taskmaster.js";

const cal = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap(e => ["BEGIN:VEVENT", ...e.trim().split("\n").map(l => l.trim()), "END:VEVENT"]), "END:VCALENDAR"].join("\r\n") + "\r\n";
const on = async (ics: string, day: string, size = 0) => {
  const chunks = size ? Array.from({ length: Math.ceil(ics.length / size) }, (_, i) => ics.slice(i * size, (i + 1) * size)) : [ics];
  return eventsOnDay(chunks, day);
};
const titles = (r: { events: { title: string; time: string }[] }) => r.events.map(e => e.title + " " + e.time);

// ── 予定：1 日分だけ取り出す ──
test("予定：時刻つき・世界時刻（Z）・終日・何日もまたぐ終日。日本時間のその日に重なるものだけ", async () => {
  const ics = cal(
    "UID:a\nSUMMARY:朝会\nDTSTART;TZID=Asia/Tokyo:20261013T090000\nDTEND;TZID=Asia/Tokyo:20261013T093000",
    "UID:b\nSUMMARY:夜の打合せ\nDTSTART:20261013T120000Z\nDTEND:20261013T130000Z",          // 21:00〜22:00 JST
    "UID:c\nSUMMARY:翌日へ\nDTSTART:20261013T160000Z\nDTEND:20261013T170000Z",              // 10/14 01:00 JST → 10/13 には出ない
    "UID:d\nSUMMARY:祝日\nDTSTART;VALUE=DATE:20261013\nDTEND;VALUE=DATE:20261014",
    "UID:e\nSUMMARY:出張\nDTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261015",
    "UID:f\nSUMMARY:前の日\nDTSTART;TZID=Asia/Tokyo:20261012T090000\nDTEND;TZID=Asia/Tokyo:20261012T100000",
  );
  const r = await on(ics, "2026-10-13");
  assert.deepEqual(titles(r), ["出張 終日", "祝日 終日", "朝会 09:00〜09:30", "夜の打合せ 21:00〜22:00"]);
  assert.equal(r.events[2].start, "2026-10-13T09:00:00+09:00");
  assert.equal(r.unreadable, 0);
  assert.equal(r.scanned, 6);
});

test("予定：毎週の繰り返し（BYDAY・INTERVAL・COUNT・UNTIL・EXDATE）", async () => {
  const ics = cal(
    "UID:w1\nSUMMARY:毎週火木\nDTSTART;TZID=Asia/Tokyo:20260901T100000\nDTEND;TZID=Asia/Tokyo:20260901T110000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH",
    "UID:w2\nSUMMARY:隔週\nDTSTART;TZID=Asia/Tokyo:20261006T120000\nDTEND;TZID=Asia/Tokyo:20261006T130000\nRRULE:FREQ=WEEKLY;INTERVAL=2",   // 10/6 の次は 10/20
    "UID:w3\nSUMMARY:4回だけ\nDTSTART;TZID=Asia/Tokyo:20260915T130000\nDTEND;TZID=Asia/Tokyo:20260915T140000\nRRULE:FREQ=WEEKLY;COUNT=4", // 9/15・22・29・10/6
    "UID:w4\nSUMMARY:10月6日まで\nDTSTART;TZID=Asia/Tokyo:20260901T150000\nDTEND;TZID=Asia/Tokyo:20260901T160000\nRRULE:FREQ=WEEKLY;UNTIL=20261006T060000Z",
    "UID:w5\nSUMMARY:今週だけ休み\nDTSTART;TZID=Asia/Tokyo:20260901T170000\nDTEND;TZID=Asia/Tokyo:20260901T180000\nRRULE:FREQ=WEEKLY\nEXDATE;TZID=Asia/Tokyo:20261013T170000",
    "UID:w6\nSUMMARY:毎日\nDTSTART;TZID=Asia/Tokyo:20261001T070000\nDTEND;TZID=Asia/Tokyo:20261001T071500\nRRULE:FREQ=DAILY",
  );
  const r = await on(ics, "2026-10-13");
  assert.deepEqual(titles(r), ["毎日 07:00〜07:15", "毎週火木 10:00〜11:00"]);
  const r20 = await on(ics, "2026-10-20");
  assert.deepEqual(titles(r20), ["毎日 07:00〜07:15", "毎週火木 10:00〜11:00", "隔週 12:00〜13:00", "今週だけ休み 17:00〜18:00"]);
  const r6 = await on(ics, "2026-10-06");
  assert.ok(titles(r6).includes("4回だけ 13:00〜14:00"));
  assert.ok(titles(r6).includes("10月6日まで 15:00〜16:00"));
});

test("予定：動かした回（RECURRENCE-ID）は元の時刻を消して新しい時刻で出す。取り消した回は出さない", async () => {
  const ics = cal(
    "UID:h\nSUMMARY:ヒロセ＠定例\nDTSTART;TZID=Asia/Tokyo:20260907T130000\nDTEND;TZID=Asia/Tokyo:20260907T140000\nRRULE:FREQ=WEEKLY;BYDAY=TU",
    "UID:h\nSUMMARY:ヒロセ＠定例\nRECURRENCE-ID;TZID=Asia/Tokyo:20261013T130000\nDTSTART;TZID=Asia/Tokyo:20261013T140000\nDTEND;TZID=Asia/Tokyo:20261013T150000",
    "UID:x\nSUMMARY:取り消し\nDTSTART;TZID=Asia/Tokyo:20260901T100000\nDTEND;TZID=Asia/Tokyo:20260901T110000\nRRULE:FREQ=WEEKLY",
    "UID:x\nRECURRENCE-ID;TZID=Asia/Tokyo:20261013T100000\nSTATUS:CANCELLED\nDTSTART;TZID=Asia/Tokyo:20261013T100000\nDTEND;TZID=Asia/Tokyo:20261013T110000",
  );
  assert.deepEqual(titles(await on(ics, "2026-10-13")), ["ヒロセ＠定例 14:00〜15:00"]);
  assert.deepEqual(titles(await on(ics, "2026-10-20")), ["取り消し 10:00〜11:00", "ヒロセ＠定例 13:00〜14:00"]);
});

test("予定：毎月・毎年（第2月曜・最終金曜・日付）、別の時間帯、折り返した行、途中で切れた束", async () => {
  const ics = cal(
    "UID:m1\nSUMMARY:第2月曜\nDTSTART;TZID=Asia/Tokyo:20260112T090000\nDTEND;TZID=Asia/Tokyo:20260112T100000\nRRULE:FREQ=MONTHLY;BYDAY=2MO",
    "UID:m2\nSUMMARY:月末金曜\nDTSTART;TZID=Asia/Tokyo:20260130T090000\nDTEND;TZID=Asia/Tokyo:20260130T100000\nRRULE:FREQ=MONTHLY;BYDAY=-1FR",
    "UID:m3\nSUMMARY:毎月12日\nDTSTART;VALUE=DATE:20260112\nRRULE:FREQ=MONTHLY",
    "UID:y1\nSUMMARY:記念日\nDTSTART;VALUE=DATE:20201012\nDTEND;VALUE=DATE:20201013\nRRULE:FREQ=YEARLY",
    "UID:n\nSUMMARY:NYの朝\nDTSTART;TZID=\"America/New_York\":20261011T200000\nDTEND;TZID=\"America/New_York\":20261011T210000",  // 10/12 09:00 JST
    "UID:f\nSUMMARY:とても長い題\n名の予定\nDTSTART;TZID=Asia/Tokyo:20261012T200000\nDTEND;TZID=Asia/Tokyo:20261012T210000",
  ).replace("SUMMARY:とても長い題\r\n名の予定", "SUMMARY:とても長い題\r\n 名の予定");
  const r = await on(ics, "2026-10-12", 7);
  assert.deepEqual(titles(r), ["記念日 終日", "毎月12日 終日", "NYの朝 09:00〜10:00", "第2月曜 09:00〜10:00", "とても長い題名の予定 20:00〜21:00"]);
  assert.deepEqual(titles(await on(ics, "2026-10-30")), ["月末金曜 09:00〜10:00"]);
});

test("予定：読めない形は推測で広げずに数える（BYSETPOS・知らない時間帯・THISANDFUTURE）", async () => {
  const ics = cal(
    "UID:p\nSUMMARY:第1平日\nDTSTART;TZID=Asia/Tokyo:20260101T090000\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1",
    "UID:t\nSUMMARY:謎の時間帯\nDTSTART;TZID=Tokyo Standard Time:20261013T090000\nDTEND;TZID=Tokyo Standard Time:20261013T100000",
    "UID:r\nSUMMARY:以後ぜんぶ\nRECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Asia/Tokyo:20261013T090000\nDTSTART;TZID=Asia/Tokyo:20261013T100000",
  );
  const r = await on(ics, "2026-10-13");
  assert.equal(r.events.length, 0);
  assert.equal(r.unreadable, 3);
  assert.equal(parseRule("FREQ=HOURLY"), null);
});

// ── タスク：こなしたこと・残ったこと ──
test("タスク：こなしたことは doneAt がその日の完了。残ったことは着手日か期限がその日以前で、その日の終わりに未完了", () => {
  const T = (id: string, o: Record<string, unknown>) => ({ id, title: "タスク" + id, completed: false, archived: false, ...o });
  const r = splitTasks("2026-10-13", {
    doneThatDay: [T("d1", { completed: true, doneAt: "2026-10-13", completedAt: "2026-10-13T20:55:12+09:00", projectId: "p1" }), T("d2", { completed: false, doneAt: "2026-10-13" })],
    open: [T("o1", { deadline: "2026-10-13" }), T("o2", { startDate: "2026-10-10", deadline: "2026-10-31" }), T("o3", { deadline: "2026-10-14" }), T("o4", { deadline: "2026-10-01", archived: true }),
      T("o5", { deadline: "2026-10-12", createdAt: "2026-10-14" }), T("o6", {})],
    doneLater: [T("l1", { completed: true, doneAt: "2026-10-14", deadline: "2026-10-13" }), T("l2", { completed: true, doneAt: "2026-10-14", deadline: "2026-10-20" })],
    projects: new Map([["p1", "メンシプ"]]), links: new Map([["o1", "m1"]]), milestones: new Map([["m1", "全体設計"]]),
  });
  assert.deepEqual(r.done.map(t => [t.id, t.project_title, t.completed_at]), [["d1", "メンシプ", "2026-10-13T20:55:12+09:00"]]);
  assert.deepEqual(r.remaining.map(t => t.id), ["l1", "o1", "o2"]);
  assert.equal(r.remaining[1].milestone_title, "全体設計");
});

test("カレンダーの保存の形：複数（v2）・前の 1 件・無し・読めない形", () => {
  assert.deepEqual(calendarsOf({ version: 2, calendars: [{ id: "a", name: "メイン", url: "https://x/a.ics" }, { id: "b", name: "", url: "https://x/b.ics" }] }),
    [{ name: "メイン", url: "https://x/a.ics" }, { name: "カレンダー2", url: "https://x/b.ics" }]);
  assert.deepEqual(calendarsOf({ url: "https://x/a.ics", updatedAt: "" }), [{ name: "メイン", url: "https://x/a.ics" }]);
  assert.deepEqual(calendarsOf(null), []);
  assert.throws(() => calendarsOf({ version: 3 }), /読めません/);
});

test("記録くん：日付の欄と決まりへの結びを表の定義から決める。決まらなければ止める", () => {
  const spec = { definitions: {
    daily_logs: { properties: { id: { format: "uuid" }, date: { format: "date" }, created_at: { format: "timestamp with time zone" }, pomodoro_count: { format: "integer" } } },
    rule_checks: { properties: { id: { format: "uuid" }, log_date: { format: "date" }, rule: { format: "uuid", description: "Note:\nThis is a Foreign Key to `rules.id`.<fk table='rules' column='id'/>" } } },
    two: { properties: { a: { format: "date" }, b: { format: "date" } } },
  } };
  assert.equal(dateColumnOf(spec, "daily_logs"), "date");
  assert.equal(dateColumnOf(spec, "rule_checks"), "log_date");
  assert.equal(ruleFkOf(spec), "rule");
  assert.throws(() => dateColumnOf(spec, "two"), /1 つに決まりません/);
  assert.throws(() => dateColumnOf(spec, "nope"), /見つかりません/);
});

test("Firestore に置けない配列の中の配列は、その配列だけ文字にする", () => {
  assert.deepEqual(firestoreSafe({ a: [1, [2, 3], { b: [4, [5]] }], c: "x" }), { a: [1, "[2,3]", { b: [4, "[5]"] }], c: "x" });
});

test("終わった時刻は日本時間の ISO", () => {
  assert.equal(tokyoNowIso(new Date("2026-10-13T11:55:12.345Z")), "2026-10-13T20:55:12+09:00");
});

// ── v1.41.0：時間帯 ──
test("時間帯：こなしたこと・残ったことに groupId と時間帯の題名が付く。時間帯なしは null。今ある欄はそのまま", () => {
  const T = (id: string, o: Record<string, unknown>) => ({ id, title: "タスク" + id, completed: false, archived: false, ...o });
  const groups = groupsMapOf([{ id: "g1", title: "routine" }, { id: "g2", title: "Side Quest" }, { title: "id なし" }]);
  const r = splitTasks("2026-10-24", {
    doneThatDay: [T("d1", { completed: true, doneAt: "2026-10-24", groupId: "g1" }), T("d2", { completed: true, doneAt: "2026-10-24" })],
    open: [T("o1", { deadline: "2026-10-24", groupId: "g9" })], doneLater: [],
    projects: new Map(), links: new Map(), milestones: new Map(), groups,
  });
  assert.deepEqual(r.done.map(t => [t.id, t.group_id, t.group_title]), [["d1", "g1", "routine"], ["d2", null, null]]);
  assert.deepEqual(r.remaining.map(t => [t.id, t.group_id, t.group_title]), [["o1", "g9", null]]);
  assert.deepEqual(Object.keys(r.done[0]).slice(0, 12), ["id", "title", "status", "priority", "project_id", "project_title", "milestone_id", "milestone_title", "start_date", "deadline", "done_at", "completed_at"]);
  assert.equal(groupsMapOf(null).size, 0);
});

test("時間帯：前の記録（欄が無い行）だけに今のタスクから付ける。欄がある行と見つからないタスクは触らない", () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: "done", priority: null, project_id: null, project_title: null, milestone_id: null, milestone_title: null, start_date: null, deadline: null, done_at: null, completed_at: null, ...extra });
  const days = [{ date: "2026-10-24", done: [row("rw6l2o9"), row("x", { group_id: "g2", group_title: "Side Quest" }), row("gone")], remaining: [row("26yx1lz")] }] as any;
  const n = fillGroups(days, new Map([["rw6l2o9", "g1"], ["26yx1lz", null], ["x", "g1"]]), new Map([["g1", "routine"]]));
  assert.equal(n, 2);
  assert.deepEqual([days[0].done[0].group_id, days[0].done[0].group_title], ["g1", "routine"]);
  assert.deepEqual([days[0].done[1].group_id, days[0].done[1].group_title], ["g2", "Side Quest"]);
  assert.equal("group_id" in days[0].done[2], false);
  assert.deepEqual([days[0].remaining[0].group_id, days[0].remaining[0].group_title], [null, null]);
});

// ── 外に触る部分：偽の Firestore・Supabase・カレンダーで、組む・書く・変わらなければ書かない・読めない元は前を残す ──
test("組む：5 つを組んで 1 回書く。同じ中身なら書かない。カレンダーが読めない回は前の予定を残す", async () => {
  const uid = "uid1";
  const env: any = { NAOKI_UID: uid, FIREBASE_SA_EMAIL: "x", FIREBASE_SA_PRIVATE_KEY: "x", SUPABASE_URL: "https://sb.example", SUPABASE_SERVICE_ROLE_KEY: "eyJkey" };
  const sv = (v: string) => ({ stringValue: v });
  const map = (o: Record<string, any>) => ({ mapValue: { fields: o } });
  const docs: Record<string, any> = {
    "app_data/tm_layout": { fields: { value: map({ version: { integerValue: "2" } }) }, updateTime: "L" },
    "app_data/os_daily_2026": { updateTime: "D", fields: { value: map({ "2026-10-13": map({ report: map({ goal: sv("設計を決める"), achieved: sv("") }), kpiValues: map({ k1: { integerValue: "3" } }) }) }) } },
    "app_data/os_kpis": { updateTime: "K", fields: { value: { arrayValue: { values: [map({ id: sv("k1"), title: sv("投稿"), unit: sv("本") })] } } } },
    "app_data/projects": { updateTime: "P", fields: { value: { arrayValue: { values: [map({ id: sv("p1"), title: sv("メンシプ") })] } } } },
    "app_data/os_task_links_v1": { updateTime: "T", fields: { value: map({ schemaVersion: { integerValue: "1" }, history: { arrayValue: {} }, links: { arrayValue: { values: [map({ taskId: sv("o1"), milestoneId: sv("m1"), at: sv("") })] } } }) } },
    "app_data/os_roadmap_v1": { updateTime: "R", fields: { value: map({ version: { integerValue: "1" }, milestones: { arrayValue: { values: [map({ id: sv("m1"), title: sv("全体設計"), status: sv("todo") })] } } }) } },
    "app_data/os_calendar_private_v1": { updateTime: "C", fields: { value: map({ version: { integerValue: "2" }, calendars: { arrayValue: { values: [map({ id: sv("a"), name: sv("メイン"), url: sv("https://calendar.example/private.ics") })] } } }) } },
  };
  const task = (id: string, f: Record<string, any>) => ({ document: { name: "x/tm_tasks/" + id, fields: { title: sv("タスク" + id), archived: { booleanValue: false }, ...f } } });
  let calOk = true, written: any = null, writes = 0, calCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input); const method = init.method ?? "GET";
    if (url.startsWith("https://calendar.example/")) {
      calCalls++;
      assert.equal(init.redirect, "manual"); assert.equal(init.cache, undefined);
      if (!calOk) return new Response("no", { status: 404 });
      return new Response(cal("UID:e1\nSUMMARY:定例\nDTSTART;TZID=Asia/Tokyo:20261013T130000\nDTEND;TZID=Asia/Tokyo:20261013T140000"));
    }
    if (url.startsWith("https://sb.example/rest/v1/")) {
      const p = url.slice("https://sb.example/rest/v1/".length);
      if (p === "") return Response.json({ definitions: { daily_logs: { properties: { date: { format: "date" }, pomodoro_count: { format: "integer" } } },
        rule_checks: { properties: { date: { format: "date" }, rule_id: { format: "uuid" }, done: { format: "boolean" } } } } });
      if (p.startsWith("daily_logs")) { assert.match(p, /date=gte\.2026-10-13&date=lte\.2026-10-13/); return Response.json([{ date: "2026-10-13", pomodoro_count: 6 }]); }
      if (p.startsWith("rule_checks")) return Response.json([{ date: "2026-10-13", rule_id: "r1", done: true }]);
      if (p.startsWith("rules")) return Response.json([{ id: "r1", name: "7時に起きる" }]);
    }
    if (url.includes(":runQuery")) {
      const f = JSON.parse(init.body).structuredQuery.where.fieldFilter;
      if (f.field.fieldPath === "doneAt" && f.op === "EQUAL") return Response.json([task("d1", { completed: { booleanValue: true }, doneAt: sv("2026-10-13"), projectId: sv("p1") })]);
      if (f.field.fieldPath === "completed") return Response.json([task("o1", { completed: { booleanValue: false }, deadline: sv("2026-10-13") })]);
      if (f.op === "GREATER_THAN") return Response.json([{ readTime: "x" }]);
    }
    const path = decodeURIComponent(url.split("/documents/")[1] ?? "").split("?")[0].replace("users/" + uid + "/", "");
    if (path === "app_data/os_day_record_v1_2026-10-13") {
      if (method === "PATCH") { writes++; written = JSON.parse(init.body).fields.value; return Response.json({}); }
      return written ? Response.json({ updateTime: "W" + writes, fields: { value: written } }) : new Response("{}", { status: 404 });
    }
    if (method === "GET" && docs[path]) return Response.json(docs[path]);
    if (method === "GET") return new Response("{}", { status: 404 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const r1 = await buildDayRecord(env, "2026-10-13", { at: "2026-10-13T15:00:00.000Z", token: "tok" });
    assert.deepEqual(r1.counts, { done: 1, remaining: 1, events: 1, rule_checks: 1, daily_log: true, kpi: 1 });
    assert.equal(r1.written, true);
    assert.match(r1.detail, /こなしたこと 1・残ったこと 1・予定 1（カレンダー 1\/1 読めた）・記録くん その日の行あり・チェック 1・書いた$/);
    const r2 = await buildDayRecord(env, "2026-10-13", { at: "2026-10-13T15:30:00.000Z", token: "tok" });
    assert.equal(r2.written, false, "中身が同じなら書かない");
    assert.equal(writes, 1);
    calOk = false;
    const r3 = await buildDayRecord(env, "2026-10-13", { at: "2026-10-13T16:00:00.000Z", dryRun: true, token: "tok" });
    assert.equal(r3.counts.events, 1, "読めなかったカレンダーの予定は前の記録から残す");
    assert.match(r3.sources.calendar, /前の記録を残した/);
    assert.equal(r3.record!.kiroku.rule_checks[0].rule && (r3.record!.kiroku.rule_checks[0].rule as any).name, "7時に起きる");
    assert.equal(r3.record!.report.goal, "設計を決める");
    assert.equal(r3.record!.report.achieved, null);
    assert.equal(r3.record!.kpi[0].title, "投稿");
    assert.equal(r3.record!.remaining[0].milestone_title, "全体設計");
    assert.equal(writes, 1, "見るだけでは書かない");
  } finally { globalThis.fetch = orig; }
});
