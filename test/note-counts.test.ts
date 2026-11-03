import test from "node:test";
import assert from "node:assert/strict";
import { memberHints, pickMembers } from "../src/note-counts-core.ts";

test("memberHints と pickMembers：人数の欄を拾う・無ければ null（2026-11-03）", () => {
  const d = { followerCount: 1200, circle: { membersCount: 25, planCount: 2, isMember: false }, hasCircle: true };
  const f = memberHints(d);
  assert.deepEqual(f, { "circle.membersCount": 25 });
  assert.equal(pickMembers(f), 25);
  assert.equal(pickMembers(memberHints({ followerCount: 3 })), null);
});
