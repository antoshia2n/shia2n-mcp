// v1.131.0：マネージャーくん 6便目（任せる段階と自動実行）の計算。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { autoQueue, checkRequest, requestOut, requestText, routineTokenOk, routineUrlOk } from "../src/manager-run.ts";

test("routineUrlOk・routineTokenOk", () => {
  assert.equal(routineUrlOk("https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire"), true);
  assert.equal(routineUrlOk("https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef"), false);
  assert.equal(routineUrlOk("https://evil.example.com/v1/claude_code/routines/trig_01ABCdef/fire"), false);
  assert.equal(routineTokenOk("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(routineTokenOk("abc"), false);
});

test("checkRequest：題は 1〜120 字・レシピは名前の形", () => {
  assert.equal(checkRequest({ title: "" }).ok, false);
  assert.equal(checkRequest({ title: "あ".repeat(121) }).ok, false);
  assert.equal(checkRequest({ title: "x", recipe: "シアニン LP" }).ok, false);
  const c = checkRequest({ title: "  LP の  見出しを直す ", recipe: "shia2n-lp", stop: "会員に触る" });
  assert.ok(c.ok && c.row.title === "LP の 見出しを直す" && c.row.recipe === "shia2n-lp");
});

test("autoQueue：段階 0 は動かさない・1 はチャットの案だけ OK 待ち・2 はそのまま", () => {
  assert.equal(autoQueue(0, "Naoki"), false);
  assert.equal(autoQueue(1, "チャット"), false);
  assert.equal(autoQueue(1, "Naoki"), true);
  assert.equal(autoQueue(1, "直し"), true);
  assert.equal(autoQueue(2, "チャット"), true);
});

test("requestText：番号・作業・止める条件・直しの元が入る", () => {
  const req = { id: 7, title: "直し：見出し", body: "もっと短く", why: "", stop: "", recipe: null, source: "直し", fix: "もっと短く" };
  const work = { id: 3, name: "るーみん LP", area: "るーみん", level: 1 };
  const t = requestText(req, work, 42, { parent: { id: 6, title: "見出し", result: "3 案を出した", session_url: "https://claude.ai/code/session_x" }, done: [{ text: "見出しを出した", link: null, at: "2026-11-22T00:00:00Z" }], chats: [{ name: "壁打ち", state: "進行中", url: "https://claude.ai/chat/abc" }] });
  assert.match(t, /依頼番号：7/);
  assert.match(t, /チャット番号：42/);
  assert.match(t, /作業：るーみん LP（分野：るーみん・作業番号 3・段階 1）/);
  assert.match(t, /止める条件：（指定なし/);
  assert.match(t, /依頼 #6「見出し」への直し/);
  assert.match(t, /skills__feedback_add/);
  assert.match(t, /claude\.ai\/chat\/abc/);
});

test("requestOut：返す形", () => {
  const o = requestOut({ id: 1, work_id: 2, title: "t", body: "", why: "", stop: "", recipe: null, state: "OK待ち", source: "チャット", created_at: "2026-11-22T00:00:00Z" }, { name: "w", area: null });
  assert.equal(o.番号, 1); assert.equal(o.作業, "w"); assert.equal(o.状態, "OK待ち"); assert.equal(o.作った, "2026-11-22 09:00");
});
