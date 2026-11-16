import { test } from "node:test";
import assert from "node:assert/strict";
import { addFeedback, feedbackFiles, feedbackSummary, listFeedback, recipesUsing, resolveFeedback } from "../src/feedback-core.ts";

test("足す：無いファイルは見出しから作り、番号は 1 から", () => {
  const a = addFeedback(null, "shia2n-koboke", { words: "ボケが弱い。\nもっとずらして", date: "2026-11-16", recipe: "shia2n-10sen-koboke" });
  assert.equal(a.id, 1);
  assert.match(a.md, /^# 直しの記録：shia2n-koboke/);
  assert.match(a.md, /- F1 2026-11-16 未反映 ［レシピ shia2n-10sen-koboke］ ボケが弱い。 もっとずらして\n$/);
  const b = addFeedback(a.md, "shia2n-koboke", { words: "共感寄りに", date: "2026-11-17" });
  assert.equal(b.id, 2);
  const items = listFeedback(b.md);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { id: 2, date: "2026-11-17", status: "未反映", recipe: null, words: "共感寄りに", resolved: null });
  assert.equal(items[0].recipe, "shia2n-10sen-koboke");
});

test("言葉の中の → は行の区切りと取り違えないように置き換える", () => {
  const a = addFeedback(null, "x", { words: "A → B にする", date: "2026-11-16" });
  assert.equal(listFeedback(a.md)[0].words, "A ⇒ B にする");
});

test("反映：未反映だけ変わり、版と日付が行末に付く。無い番号は missing", () => {
  let md = addFeedback(null, "s", { words: "一", date: "2026-11-16" }).md;
  md = addFeedback(md, "s", { words: "二", date: "2026-11-16" }).md;
  const r = resolveFeedback(md, { ids: [1, 9], status: "反映済み", version: "1.2", date: "2026-11-17" });
  assert.deepEqual(r.changed, [1]);
  assert.deepEqual(r.missing, [9]);
  const items = listFeedback(r.md);
  assert.equal(items[0].status, "反映済み");
  assert.equal(items[0].words, "一");
  assert.equal(items[0].resolved, "反映済み 1.2（2026-11-17）");
  assert.equal(items[1].status, "未反映");
  // 2 回目は変わらない
  assert.deepEqual(resolveFeedback(r.md, { ids: [1], status: "見送り", date: "2026-11-18" }).changed, []);
});

test("見送りは理由を付けられる", () => {
  const md = addFeedback(null, "s", { words: "一", date: "2026-11-16" }).md;
  const r = resolveFeedback(md, { ids: [1], status: "見送り", date: "2026-11-17", note: "その回だけの直し" });
  assert.equal(listFeedback(r.md)[0].resolved, "見送り（2026-11-17） その回だけの直し");
});

test("目安：未反映 2 件で届く", () => {
  let md = addFeedback(null, "s", { words: "一", date: "2026-11-16" }).md;
  assert.equal(feedbackSummary("s", listFeedback(md)).改善の目安, false);
  md = addFeedback(md, "s", { words: "二", date: "2026-11-16" }).md;
  assert.deepEqual(feedbackSummary("s", listFeedback(md)), { skill: "s", 未反映: 2, 改善の目安: true });
});

test("ファイルの並びと、使っているレシピ", () => {
  assert.deepEqual(feedbackFiles([{ path: "feedback/shia2n-koboke.md", type: "blob" }, { path: "skills/a/SKILL.md", type: "blob" }, { path: "feedback/README", type: "blob" }]), ["shia2n-koboke"]);
  const r = recipesUsing("k", [
    { name: "r1", title: "R1", uses: [{ skill: "k", version: "1.1" }] },
    { name: "r2", uses: [{ skill: "k", version: "最新" }] },
    { name: "r3", uses: [{ skill: "z", version: "1.0" }] },
  ], "1.2");
  assert.deepEqual(r.map((x) => [x.recipe, x.上げる必要]), [["r1", true], ["r2", false]]);
});
