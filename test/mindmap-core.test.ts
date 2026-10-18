import test from "node:test";
import assert from "node:assert/strict";
import { addItems, bodyOf, findRequests, markChecks, parseBullets, toOutline, type MNodes } from "../src/mindmap-core.ts";

const base = (): MNodes => ({
  r: { id: "r", text: "26年の戦略", children: ["a", "b"], parent: null, collapsed: false, color: null, side: null },
  a: { id: "a", text: "目的の状態", children: ["a1"], parent: "r", color: "b1", side: "r", ai: "根拠を3つ足して" },
  a1: { id: "a1", text: "毎朝の現在地", children: [], parent: "a", check: "todo", memo: "長い\n文章" },
  b: { id: "b", text: "誰の", children: [], parent: "r", color: "b2", side: "l", collapsed: true },
});

test("箇条書きの文字にする：{id}・チェック・メモ・AI への指示", () => {
  const o = toOutline("r", base());
  assert.match(o, /^# 26年の戦略 \{r\}/);
  assert.match(o, /- 目的の状態 \{a\}\n  AI への指示: 根拠を3つ足して/);
  assert.match(o, /  - \[ \] 毎朝の現在地 \{a1\}\n    メモ: 長い \/ 文章/);
  assert.equal(toOutline("r", base(), "a").split("\n")[0], "# 目的の状態 {a}");
});

test("AI への指示の枝を集める", () => {
  const q = findRequests("r", base());
  assert.equal(q.length, 1);
  assert.equal(q[0].道すじ, "26年の戦略 > 目的の状態");
});

test("箇条書きを読む：字下げ・全角の空白・チェック", () => {
  const it = parseBullets("- 論点A\n  - 根拠\n　・根拠2\n- [x] 論点B\n・「」論点C");
  assert.deepEqual(it.map((x) => x.text), ["論点A", "論点B", "論点C"]);
  assert.deepEqual(it[0].children.map((x) => x.text), ["根拠", "根拠2"]);
  assert.equal(it[1].check, "done");
  assert.equal(it[2].check, "todo");
});

test("枝を足す：全部に by ai・中心の直下は色と左右・たたんだ枝は開く", () => {
  const n = base();
  const made = addItems("r", n, "r", parseBullets("- 新しい論点\n  - 子"), "出どころ");
  assert.equal(made.length, 2);
  const top = n[made[0]];
  assert.equal(top.by, "ai"); assert.equal(n[made[1]].by, "ai");
  assert.equal(top.color, "b3"); assert.equal(top.side, "r");
  assert.equal(top.memo, "出どころ");
  assert.equal(n[made[1]].parent, made[0]);
  assert.deepEqual(n.r.children.slice(0, 2), ["a", "b"]);
  addItems("r", n, "b", parseBullets("- 下"));
  assert.equal(n.b.collapsed, false);
  assert.match(bodyOf(n), /新しい論点/);
  assert.throws(() => addItems("r", n, "zz", parseBullets("x")));
});

test("チェックを済みにする・見つからない枝は分けて返す", () => {
  const n = base();
  const r = markChecks(n, ["a1", "b", "nope"], true);
  assert.deepEqual(r.変えた, ["a1", "b"]); assert.deepEqual(r.見つからない, ["nope"]);
  assert.equal(n.a1.check, "done");
  assert.deepEqual(markChecks(n, ["a1"], true).変えた, []);
});
