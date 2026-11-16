import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceWith, checkKeys, missingRefs, scanInternal, setMeta } from "../src/publish-core.ts";

const head = `---\nname: s\ndescription: "d"\nmetadata:\n  version: "1.2"\n  audience: "本人, 事業部"\n  updated: "2026-11-16"\n---\n\n# 本文\n`;

test("頭の欄：書き換え・足す・消す。本文は変えない", () => {
  const a = setMeta(head, "audience", "本人, 事業部, shiarabo_basic");
  assert.match(a, /  audience: "本人, 事業部, shiarabo_basic"\n/);
  const b = setMeta(a, "public_version", "1.2");
  assert.match(b, /metadata:\n  public_version: "1.2"\n/);
  const c = setMeta(b, "public_version", null);
  assert.doesNotMatch(c, /public_version/);
  assert.ok(c.endsWith("\n\n# 本文\n"));
  assert.equal(setMeta(head, "nothing", null), head);
});

test("内部の情報：止めるファイルと、人に見せる言葉", () => {
  const r = scanInternal([
    { path: "references/hypotheses.md", text: "x" },
    { path: "SKILL.md", text: "ふつうの行\nるーみんの台本\nskills__get を呼ぶ\nmail a@b.co" },
  ]);
  assert.deepEqual(r.blocked, ["references/hypotheses.md"]);
  assert.deepEqual(r.hits.map((h) => [h.line, h.why.slice(0, 4)]), [[2, "クライア"], [3, "本人用の"], [4, "メールア"]]);
});

test("呼ぶスキルと出す相手のキー", () => {
  assert.deepEqual(missingRefs(["a", "b", "c"], ["a"], ["b"]), ["c"]);
  assert.deepEqual(checkKeys(["shiarabo_basic", "本人", "Bad Key", "shiarabo_basic"]), { keys: ["shiarabo_basic"], bad: ["本人", "Bad Key"] });
  assert.equal(audienceWith(["本人", "事業部", "old_key"], ["shiarabo_basic"]), "本人, 事業部, shiarabo_basic");
});
