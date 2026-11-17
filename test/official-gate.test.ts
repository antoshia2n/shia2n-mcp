// v1.122.0：外向けの窓口が本人の番号で道具を呼ぶ口。走らせ方：esbuild で束ねてから node --test（cloudflare:workers は外に出す）
import test from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_GATE_TOOLS, describeTools, runTool } from "../src/official-gate.js";

const NAOKI = "VrMwzeSceqWeXVQOrm8kpu4uVR33";
const MEMBER = "70f3ce34-e17f-4d40-bd53-f47a8f7d079a";
const STUDENT_UID = "student-uid-1";
const env: any = { SUPABASE_URL: "https://sb.example", SUPABASE_SERVICE_ROLE_KEY: "k" };

function mockFetch(targets: string[], uid: string | null) {
  const urls: string[] = [];
  (globalThis as any).fetch = async (input: any) => {
    const u = String(input); urls.push(u);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/member_entitlement?")) return json([{ key: "shiarabo_pilot" }]);
    if (u.includes("/member_access?")) return json(targets.map((t) => ({ target: t })));
    if (u.includes("/member?")) return json(uid ? [{ auth_uid: uid }] : [{ auth_uid: null }]);
    if (u.includes("/xa_weeks?")) return json([{ id: "w1", label: "11月3週", month: "2026-11", sort: 1, user_id: STUDENT_UID, metrics: {} }]);
    if (u.includes("/xa_accounts?") || u.includes("/xa_obs?")) return json([]);
    return json([]);
  };
  return urls;
}

const ALL = ["mcp_official", ...OFFICIAL_GATE_TOOLS.map((n) => "mcp-" + n)];

test("名簿は X攻略くんの 8 本だけで、Naoki 専用の道具は入っていない", () => {
  assert.equal(OFFICIAL_GATE_TOOLS.length, 8);
  for (const n of OFFICIAL_GATE_TOOLS) assert.ok(n.startsWith("xbunseki__"), n);
});

test("8 本の説明文と引数の形が返る", () => {
  const got = describeTools(env, [...OFFICIAL_GATE_TOOLS, "okane__list_plans"]);
  assert.deepEqual(got.map((t) => t.name), [...OFFICIAL_GATE_TOOLS]);
  for (const t of got) { assert.equal(t.inputSchema.type, "object"); assert.ok(t.description.length > 10); }
});

test("権利の表に道具の行が無ければ動かさない", async () => {
  const urls = mockFetch(["mcp_official"], STUDENT_UID);
  const r = await runTool(env, MEMBER, "xbunseki__list_weeks", {});
  assert.deepEqual(r, { ok: false, reason: "no_right" });
  assert.ok(!urls.some((u) => u.includes("/xa_")));
});

test("名簿に無い道具は、権利の表にあっても動かさない", async () => {
  mockFetch([...ALL, "mcp-okane__list_plans"], STUDENT_UID);
  assert.deepEqual(await runTool(env, MEMBER, "okane__list_plans", {}), { ok: false, reason: "not_official" });
});

test("ログインの番号がまだ無い人は動かさない", async () => {
  mockFetch(ALL, null);
  assert.deepEqual(await runTool(env, MEMBER, "xbunseki__list_weeks", {}), { ok: false, reason: "no_login" });
});

test("本人の番号だけで読み、Naoki の番号では 1 度も読まない", async () => {
  const urls = mockFetch(ALL, STUDENT_UID);
  const r = await runTool(env, MEMBER, "xbunseki__list_weeks", {});
  assert.equal(r.ok, true);
  const xa = urls.filter((u) => u.includes("/xa_"));
  assert.ok(xa.length >= 2);
  for (const u of xa) { assert.ok(u.includes(`user_id=eq.${STUDENT_UID}`), u); assert.ok(!u.includes(NAOKI), u); }
  assert.ok(!urls.some((u) => u.includes("select=user_id&limit=200")), "Naoki を探す決め方を通っていない");
});

test("引数の形が違えば動かさない", async () => {
  mockFetch(ALL, STUDENT_UID);
  const r = await runTool(env, MEMBER, "xbunseki__list_weeks", { limit: 999 });
  assert.equal(r.ok, true);
  assert.equal((r as any).result.isError, true);
});
