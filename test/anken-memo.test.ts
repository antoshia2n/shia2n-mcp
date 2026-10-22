import test from "node:test";
import assert from "node:assert/strict";
import { memoOf, keepMemo } from "../src/anken-memo.ts";

test("AI が事前メモを書き直しても Naoki のメモは残る", () => {
  const prev = { when: "2026-10-29（木）13時", agenda: [{ title: "古い議題" }], memo: "次の定例までの優先：会員サイト関連", memo_at: "2026-10-23T00:00:00Z" };
  const next = keepMemo(prev, { when: "2026-11-05（木）13時", agenda: [{ title: "新しい議題" }] });
  assert.equal(next.memo, prev.memo);
  assert.equal(next.memo_at, prev.memo_at);
  assert.equal(next.agenda[0].title, "新しい議題");
});

test("AI が memo を渡してきても前のメモで上書きされない・無ければ足さない", () => {
  assert.equal(keepMemo({ memo: "Naoki" }, { when: "x", memo: "AI" }).memo, "Naoki");
  assert.ok(!("memo" in keepMemo({ when: "x" }, { when: "y", memo: "AI" })));
  assert.ok(!("memo" in keepMemo(null, { when: "y" })));
});

test("メモを読む", () => {
  assert.deepEqual(memoOf({ mtg: { memo: " 会員サイト ", memo_at: "t" } }), { text: "会員サイト", at: "t" });
  assert.deepEqual(memoOf({ mtg: null }), { text: "", at: null });
});
