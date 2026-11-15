// v1.106.0：仮説の1枚の書き足し・状態の変更と、レシピの @最新。走らせ方：esbuild で束ねてから node --test（リポジトリの直下で）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addHypothesis, listHypotheses, updateHypothesis } from "../src/hypothesis-core.js";
import { parseRecipeHead } from "../src/skills-core.js";

const MD = readFileSync("test/fixtures/hypotheses.md", "utf8");

test("今の2つを読める", () => {
    const l = listHypotheses(MD);
    assert.deepEqual(l.map((h) => h.id), [1, 2]);
    assert.equal(l[1].status, "仮説");
});
test("言葉のまま足し、番号は次の数", () => {
    const a = addHypothesis(MD, { title: "画像は2枚目で止める", words: "2枚目で\n止まる人が多い", date: "2026-11-16", target: "生徒だけ" });
    assert.equal(a.id, 3);
    assert.ok(a.md.includes("## H3 画像は2枚目で止める\n\n- 中身（Naoki の言葉）：2枚目で 止まる人が多い\n- 誰に当てるか（Naoki の言葉）：生徒だけ\n- 出所：Naoki（2026-11-16）\n- 状態：仮説\n"));
    assert.equal(a.md.startsWith(MD.replace(/\s+$/, "")), true);
});
test("状態を変えると前の状態を残し、ほかの仮説は動かない", () => {
    const out = updateHypothesis(MD, { id: 1, date: "2026-11-16", status: "確かめ中", note: "X攻略くんで見る" })!;
    assert.ok(out.includes("- 状態：確かめ中（2026-11-16・前は 仮説）"));
    assert.ok(out.includes("- 追記（2026-11-16）：X攻略くんで見る\n"));
    const h2 = (s: string) => s.slice(s.indexOf("## H2"));
    assert.equal(h2(out), h2(MD));
    assert.deepEqual(listHypotheses(out).map((h) => h.id), [1, 2]);
});
test("無い番号は null", () => {
    assert.equal(updateHypothesis(MD, { id: 9, date: "2026-11-16", note: "x" }), null);
});

test("固定の行と @最新 の行を両方読める", () => {
    const r = parseRecipeHead(`---\nname: r\nmetadata:\n  version: "1.4"\nskills:\n  - a-b@1.0#${"a".repeat(40)} | 優先 1 | 強さ 標準\n  - shia2n-x-review@最新 | 優先 2 | 強さ 標準\n---\n本文`, "r")!;
    assert.deepEqual(r.bad, []);
    assert.deepEqual(r.uses[1], { skill: "shia2n-x-review", version: "最新", commit: null, priority: 2, strength: "標準" });
    assert.equal(r.uses[0].commit, "a".repeat(40));
});
