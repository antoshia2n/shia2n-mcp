import test from "node:test";
import assert from "node:assert/strict";
import { archiveDoc, archiveItem, archiveSearch, archiveStatus, extractText, RateLimited, shouldStart, startRun, tick } from "../src/utage-archive.ts";

// 保管庫の代わり
function fakeBucket() {
  const m = new Map<string, string>();
  return {
    m,
    async get(k: string) { const v = m.get(k); return v === undefined ? null : { text: async () => v }; },
    async put(k: string, v: string) { m.set(k, String(v)); },
  } as unknown as R2Bucket & { m: Map<string, string> };
}

// UTAGE の代わり（小さな木）
function fakeUtage(opts: { failTool?: string; rateAfter?: number } = {}) {
  let n = 0;
  const calls: string[] = [];
  const call = async (t: string, a: Record<string, unknown>) => {
    n++;
    calls.push(t);
    if (opts.rateAfter && n === opts.rateAfter) throw new RateLimited("429");
    if (t === opts.failTool) throw new Error("こわれた");
    switch (t) {
      case "funnel_list": return { data: [{ id: "F1", name: "しあらぼ決済用ファネル" }], meta: { current_page: 1, last_page: 1, total: 1 } };
      case "funnel_step_list": return { data: [{ id: "S1", name: "LP", step_url: "https://utage/s1" }, { id: "S2", name: "サンクス" }] };
      case "funnel_page_list": return { data: [{ id: a.step_id === "S1" ? "P1" : "P2", title: "ページ" }] };
      case "funnel_page_get": return { data: { title: a.page_id === "P1" ? "LP 本体" : "サンクス", page_url: "https://utage/p", content_type: "elements", elements: [{ type: "text", id: "abcdefgh12", color: "#ff0000", html: "<p>言語化で<b>人生</b>が変わる</p>" }, { text: "今すぐ申し込む" }] } };
      case "funnel_tracking_list": return { data: [{ id: "T1", name: "X から", url: "https://utage/t" }] };
      case "funnel_stats_get": return { data: { pv: 10 } };
      case "message_account_list": return { data: [{ id: "A1", name: "シアニン", type: "mail_line" }] };
      case "message_scenario_list": return { data: [{ id: "SC1", title: "通常メインシナリオ" }] };
      case "message_list": return a.page === 1 ? { data: [{ id: "M1" }], meta: { current_page: 1, last_page: 2 } } : { data: [{ id: "M2" }], meta: { current_page: 2, last_page: 2 } };
      case "message_get": return { data: { subject: a.message_id === "M1" ? "ようこそ" : "2 通目", channel: "mail", type: "step", body: "{name}さん、こんにちは" } };
      case "message_reader_list_all": return a.page === 1 ? { data: Array.from({ length: 100 }, (_, i) => ({ id: "r" + i, mail: `p${i}@x.jp` })), meta: { total: 150 } } : { data: Array.from({ length: 50 }, (_, i) => ({ id: "s" + i, mail: `q${i}@x.jp` })), meta: { total: 150 } };
      case "message_line_friend_list": return { data: [{ id: "L1", display_name: "山田" }], meta: { total: 1 } };
      case "message_line_template_list": return { data: [{ id: "LT1", name: "申込お礼" }], meta: { total: 1 } };
      case "message_line_template_get": return { data: { name: "申込お礼", line: { messages: [{ type: "text", text: "ありがとうございます" }] } } };
      case "message_line_autoreply_list": return { data: [{ id: "AR1", name: "資料", keyword: "資料", messages: [{ text: "こちらです" }] }], meta: { total: 1 } };
      case "event_list": return a.is_archived ? { data: [], meta: { total: 0 } } : { data: [{ id: "E1", name: "個別相談会", type: "calendar", register_url: "https://utage/e" }], meta: { total: 1 } };
      case "event_get": return { data: { name: "個別相談会", description: "30 分の相談です" } };
      case "event_applicant_list": return { data: [{ id: "AP1", mail: "x@y.jp" }, { id: "AP2" }], meta: { total: 2 } };
      case "member_site_list": return { data: [{ id: "SITE1", name: "言語化カレッジ" }], meta: { total: 1 } };
      case "member_course_list": return { data: [{ id: "C1", name: "第1部" }] };
      case "member_lesson_list": return { data: [{ id: "LS1", name: "はじめに", type: "html" }, { id: "LS2", name: "古い形", type: "rich_text" }], meta: { total: 2 } };
      case "member_lesson_get": return { data: { name: "はじめに", elements: [{ html: "<h2>言語化とは</h2>" }] } };
      case "member_student_list": return { data: [{ id: "ST1", mail: "s@y.jp" }], meta: { total: 1 } };
      case "payment_product_list": return a.is_archived ? { data: [] } : { data: [{ id: "PR1", name: "しあらぼ" }] };
      case "payment_product_detail_list": return { data: [{ id: "PD1", name: "月額", charge_type: "subscription", amount: 9800 }] };
      case "payment_purchase_list": return { data: [{ id: "PU1", customer: { mail: "z@y.jp" } }], meta: { total: 1 } };
      default: return { data: [], meta: { total: 0 } };
    }
  };
  return { call, calls };
}

const JST3 = Date.parse("2026-11-07T03:10:00+09:00");

test("文だけを抜く：HTML・色・番号を捨て、字を残す", () => {
  const t = extractText([{ id: "abcdefgh12", color: "#fff", html: "<p>言語化で<b>人生</b>が変わる</p>", style: "padding:10px;" }, { text: "今すぐ" }]);
  assert.match(t, /言語化で 人生 が変わる/);
  assert.match(t, /今すぐ/);
  assert.doesNotMatch(t, /abcdefgh12|#fff|padding/);
});

test("始める時刻：JST 3 時台で、その日の回がまだ無いときだけ", () => {
  assert.equal(shouldStart(null, null, JST3), true);
  assert.equal(shouldStart(null, "2026-11-07", JST3), false);
  assert.equal(shouldStart(null, null, Date.parse("2026-11-07T04:10:00+09:00")), false);
});

test("1 周：木を全部読み、読み物と品目を作る。個人の情報は数だけ", async () => {
  const b = fakeBucket();
  const env = { BACKUP_BUCKET: b };
  const u = fakeUtage();
  let r = await tick(env, { call: u.call, now: JST3, maxCalls: 10 });
  assert.equal(r.run, "2026-11-07");
  assert.equal(r.did, 10);
  assert.equal(r.finished, false);
  // 続きは次の回で（3 時を過ぎても続く）
  for (let i = 0; i < 20 && !r.finished; i++) r = await tick(env, { call: u.call, now: JST3 + 3600_000, maxCalls: 10 });
  assert.equal(r.finished, true);
  const st = (await archiveStatus(env)) as { latest: { run: string }; current: { items: Record<string, number>; errors: number } };
  assert.equal(st.latest.run, "2026-11-07");
  assert.equal(st.current.items.page, 2);
  assert.equal(st.current.items.message, 2, "次のページのメッセージも読む");
  assert.equal(st.current.items.lesson, 2, "リッチテキストは名前だけで並ぶ");
  assert.equal(st.current.errors, 0);
  const people = (await archiveDoc(env, "people")) as { markdown: string };
  assert.match(people.markdown, /シアニン：150/);
  assert.doesNotMatch(people.markdown, /@x\.jp|@y\.jp|山田/);
  for (const d of ["overview", "funnels", "scenarios", "line", "events", "member_sites", "products", "media"]) {
    const md = (await archiveDoc(env, d)) as { ok: boolean; markdown: string };
    assert.equal(md.ok, true, d);
    assert.doesNotMatch(md.markdown, /@x\.jp|@y\.jp/, d);
  }
  const fun = (await archiveDoc(env, "funnels")) as { markdown: string };
  assert.match(fun.markdown, /しあらぼ決済用ファネル › LP/);
  assert.match(fun.markdown, /`page:P1`/);
  const page = (await archiveItem(env, "page:P1", { raw: true })) as { text: string; raw: { data: { title: string } } };
  assert.match(page.text, /言語化で 人生 が変わる/);
  assert.equal(page.raw.data.title, "LP 本体");
  const ev = (await archiveItem(env, "event:E1")) as { text: string };
  assert.match(ev.text, /30 分の相談/);
  assert.equal(((await archiveItem(env, "reader:r1")) as { error: string }).error, "personal");
  const s = (await archiveSearch(env, { words: "ようこそ" })) as { rows: { ref: string }[] };
  assert.deepEqual(s.rows.map((x) => x.ref), ["message:M1"]);
  // raw は残る（移す便の元）
  assert.ok([...b.m.keys()].some((k) => k.includes("/raw/message_reader_list_all/")));
});

test("読めない道具は 1 回やり直して、だめなら失敗に残して先へ進む", async () => {
  const b = fakeBucket();
  const env = { BACKUP_BUCKET: b };
  const u = fakeUtage({ failTool: "member_lesson_get" });
  let r = await tick(env, { call: u.call, now: JST3, maxCalls: 500 });
  assert.equal(r.finished, true);
  assert.equal(u.calls.filter((t) => t === "member_lesson_get").length, 2);
  const st = (await archiveStatus(env)) as { current: { errors: number } };
  assert.equal(st.current.errors, 1);
  const ov = (await archiveDoc(env, "overview")) as { markdown: string };
  assert.match(ov.markdown, /member_lesson_get.*こわれた/);
});

test("回数の上限に当たったら止めて、次の回で同じところから続ける", async () => {
  const b = fakeBucket();
  const env = { BACKUP_BUCKET: b };
  const u = fakeUtage({ rateAfter: 3 });
  const r = await tick(env, { call: u.call, now: JST3, maxCalls: 500 });
  assert.equal(r.did, 2);
  assert.ok(r.stopped);
  const r2 = await tick(env, { call: fakeUtage().call, now: JST3 + 900_000, maxCalls: 500 });
  assert.equal(r2.finished, true);
});

test("手で始める：読み終わっていない回があるときは始めない", async () => {
  const b = fakeBucket();
  const env = { BACKUP_BUCKET: b };
  assert.equal((await startRun(env, JST3 + 6 * 3600_000)).ok, true);
  assert.equal((await startRun(env, JST3 + 6 * 3600_000)).ok, false);
});
