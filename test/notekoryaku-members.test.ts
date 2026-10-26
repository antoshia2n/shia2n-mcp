// v1.53.0：note攻略くんのレポートに haAku のメンシプ在籍数を出す受け口。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { findMembersKpi, handleNotekoryakuMembers, monthlyLatest, NOTEKORYAKU_MEMBERS_PATH, NOTEKORYAKU_ORIGIN } from "../src/notekoryaku-members-http.js";

test("KPI：題に「メンシプ」と「在籍」の両方が入るものを選ぶ", () => {
  const kpis = [{ id: "a", title: "インプ（月間）" }, { id: "b", title: "メンシプ記事の本数" }, { id: "c", title: "メンシプ在籍数" }];
  assert.equal(findMembersKpi(kpis)?.id, "c");
  assert.equal(findMembersKpi([{ id: "a", title: "インプ" }]), null);
  assert.equal(findMembersKpi([]), null);
});

test("月ごと：その月の最新の日の値。0・空・数でないもの・日付の形が違うものは数えない。月の順に並ぶ", () => {
  const d = {
    "2026-08-03": { kpiValues: { m: 29 } }, "2026-08-31": { kpiValues: { m: 30 } }, "2026-08-15": { kpiValues: { m: 31 } },
    "2026-09-30": { kpiValues: { m: 0 } }, "2026-09-20": { kpiValues: { m: 31 } },
    "2026-10-10": { kpiValues: { m: "28" } }, "2026-10-05": { kpiValues: { x: 5 } }, "2026-10-26": { kpiValues: { m: 28 } },
    "note": { kpiValues: { m: 99 } }, "2026-07-01": {},
  } as any;
  assert.deepEqual(monthlyLatest(d, "m"), { "2026-08": 30, "2026-09": 31, "2026-10": 28 });
  assert.deepEqual(Object.keys(monthlyLatest(d, "m")), ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(monthlyLatest({} as any, "m"), {});
});

test("守り：note攻略くん以外の住所は断る。札が無ければ 401。前もっての問い合わせは note攻略くんにだけ答える。読むだけ（GET 以外は 405）", async () => {
  const env = { NAOKI_UID: "u1" } as any;
  const url = "https://shia2n-mcp.example" + NOTEKORYAKU_MEMBERS_PATH;
  for (const o of ["https://x-koryaku.shia2n.jp", "https://note-koryaku.shia2n.jp.evil.example", "http://note-koryaku.shia2n.jp", ""]) {
    const r = await handleNotekoryakuMembers(new Request(url, { headers: o ? { Origin: o } : {} }), env);
    assert.equal(r.status, 403, o);
  }
  const none = await handleNotekoryakuMembers(new Request(url, { headers: { Origin: NOTEKORYAKU_ORIGIN } }), env);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("Access-Control-Allow-Origin"), NOTEKORYAKU_ORIGIN);
  const pre = await handleNotekoryakuMembers(new Request(url, { method: "OPTIONS", headers: { Origin: NOTEKORYAKU_ORIGIN } }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Methods") || "", /^GET,OPTIONS$/);
  const post = await handleNotekoryakuMembers(new Request(url, { method: "POST", headers: { Origin: NOTEKORYAKU_ORIGIN }, body: "{}" }), env);
  assert.equal(post.status, 405);
  const bad = await handleNotekoryakuMembers(new Request(url, { headers: { Origin: NOTEKORYAKU_ORIGIN, Authorization: "Bearer a.b.c" } }), env);
  assert.equal(bad.status, 403);
});
