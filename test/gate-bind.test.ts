// gate__bind_login の決め方（src/gate-bind.ts）。esbuild で束ねてから node --test。
import test from "node:test";
import assert from "node:assert/strict";
import { planBind } from "../src/gate-bind.js";

const M = { id: "m1", auth_uid: null };

test("空の行に、まだどこにも結ばれていないログインを書く", () => {
  assert.deepEqual(planBind(M, "u1", []), { ok: true, action: "write", uid: "u1" });
});

test("もう同じログインが結ばれていれば書かない（already）", () => {
  assert.deepEqual(planBind({ id: "m1", auth_uid: "u1" }, "u1", [{ id: "m1" }]), { ok: true, action: "already", uid: "u1" });
});

test("断る：行が無い・Google が無い・ほかの会員が持っている・別のログインが結ばれている", () => {
  assert.equal((planBind(null, "u1", []) as any).reason, "member_not_found");
  assert.equal((planBind(M, null, []) as any).reason, "google_not_found");
  const taken = planBind(M, "u1", [{ id: "m2" }]) as any;
  assert.equal(taken.reason, "uid_taken");
  assert.equal(taken.detail, "m2");
  assert.equal((planBind({ id: "m1", auth_uid: "u0" }, "u1", []) as any).reason, "member_has_other_login");
});
