// v1.6.1：公開を全部先に読み、鍵は残りにだけ使う。走らせ方：node --test test/impact-order.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readInOrder } from "../src/impact-core.ts";

const targets = Array.from({ length: 28 }, (_, i) => i);
const isPublic = (i: number) => i % 3 === 0; // 10 本が公開・非公開が間に挟まる

test("公開は全部読み、鍵は 404 が 2 本続いたら止める", async () => {
  const pub: number[] = [];
  const key: number[] = [];
  const out = await readInOrder(
    targets,
    async (t) => { pub.push(t); return isPublic(t) ? { ok: true } : { ok: false, status: 404, reason: "404" }; },
    async (t) => { key.push(t); return { ok: false, status: 404, reason: "404→404" }; },
    true,
  );
  assert.equal(pub.length, 28);
  assert.equal(out.filter((g) => g.ok).length, 10);
  assert.equal(key.length, 2);
  assert.match(out[26].reason!, /許可が無い/);
});

test("鍵で 1 本でも読めたら残りも鍵で試す", async () => {
  const key: number[] = [];
  const out = await readInOrder(
    targets,
    async (t) => (isPublic(t) ? { ok: true } : { ok: false, status: 404 }),
    async (t) => { key.push(t); return t === 1 ? { ok: true } : { ok: false, status: 404 }; },
    true,
  );
  assert.equal(key.length, 18);
  assert.equal(out.filter((g) => g.ok).length, 11);
});

test("鍵が無ければ鍵は呼ばない", async () => {
  let called = 0;
  const out = await readInOrder(targets, async (t) => (isPublic(t) ? { ok: true } : { ok: false, status: 404 }), async () => { called++; return { ok: true }; }, false);
  assert.equal(called, 0);
  assert.match(out[1].reason!, /鍵が無い/);
});
