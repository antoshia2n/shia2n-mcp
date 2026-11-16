// v1.107.0：レシピの書き直し（マーケくんの「スキル」の棚）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bumpVersion, writeRecipeText } from "../src/recipe-write-core.js";
import { parseRecipeHead } from "../src/skills-core.js";
import { addHypothesis, hypothesisSections } from "../src/hypothesis-core.js";

const old = "de1bcffc0668fc320cd6bc838e739a055ed0db42";
const head = "a".repeat(40);
const text = `---
name: shia2n-10sen-koboke
metadata:
  version: "1.4"
  purpose: "10選"
  where: "claude.ai, Claude Code, GPT"
  audience: "本人, 事業部"
  owner: "コンテンツ制作"
  updated: "2026-11-15"
skills:
  - shia2n-zukai-10sen@1.0#${old} | 優先 1 | 強さ 標準
  - shia2n-koboke@1.1#${old} | 優先 2 | 強さ 強
  - shia2n-x-review@最新 | 優先 3 | 強さ 標準
---

# レシピ：10選

## 流れ

1. そのまま残る本文
`;
const ctx = () => ({
  skills: new Map<string, string | null>([["shia2n-zukai-10sen", "1.0"], ["shia2n-koboke", "1.2"], ["shia2n-x-review", "1.3"], ["shia2n-zukai-kozo", "1.0"]]),
  current: new Map([["shia2n-zukai-10sen", { version: "1.0", commit: old }], ["shia2n-koboke", { version: "1.1", commit: old }], ["shia2n-x-review", { version: "最新", commit: null }]]),
  head, date: "2026-11-16",
});

test("版を 1 つ上げる", () => {
  assert.equal(bumpVersion("1.4"), "1.5");
  assert.equal(bumpVersion("1.9"), "1.10");
  assert.equal(bumpVersion(null), "1.0");
});

test("固定のまま強さと順だけ変えると、本文と他の欄は残り版が上がる", () => {
  const r = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [
    { skill: "shia2n-koboke", pin: "keep", strength: "弱" }, { skill: "shia2n-zukai-10sen", pin: "keep" }, { skill: "shia2n-x-review", pin: "keep" },
  ] }, ctx());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.version, "1.5");
  const p = parseRecipeHead(r.text, "shia2n-10sen-koboke")!;
  assert.equal(p.version, "1.5");
  assert.equal(p.updated, "2026-11-16");
  assert.deepEqual(p.audience, ["本人", "事業部"]);
  assert.deepEqual(p.uses.map((u) => [u.skill, u.version, u.commit, u.priority, u.strength]), [
    ["shia2n-koboke", "1.1", old, 1, "弱"], ["shia2n-zukai-10sen", "1.0", old, 2, "標準"], ["shia2n-x-review", "最新", null, 3, "標準"],
  ]);
  assert.deepEqual(p.bad, []);
  assert.match(r.text, /1\. そのまま残る本文/);
});

test("いまの版で固定し直すと main の今のコミットと版になる", () => {
  const r = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "shia2n-koboke", pin: "now", strength: "強" }] }, ctx());
  assert.ok(r.ok);
  if (!r.ok) return;
  const u = parseRecipeHead(r.text, "x")!.uses[0];
  assert.equal(u.version, "1.2");
  assert.equal(u.commit, head);
});

test("@最新 は基本スキルだけ。同じスキル 2 回・無いスキルは止める", () => {
  const a = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "shia2n-koboke", pin: "latest" }] }, ctx());
  assert.deepEqual(a, { ok: false, error: "latest_not_allowed:shia2n-koboke" });
  const b = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "shia2n-koboke", pin: "keep" }, { skill: "shia2n-koboke", pin: "now" }] }, ctx());
  assert.deepEqual(b, { ok: false, error: "dup_skill:shia2n-koboke" });
  const c = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "nope-skill", pin: "now" }] }, ctx());
  assert.deepEqual(c, { ok: false, error: "no_skill:nope-skill" });
  const d = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [] }, ctx());
  assert.deepEqual(d, { ok: false, error: "no_skills" });
});

test("いまのレシピに無いスキルを keep で足すと、いまの版で固定する", () => {
  const r = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "shia2n-zukai-kozo", pin: "keep" }] }, ctx());
  assert.ok(r.ok);
  if (!r.ok) return;
  const u = parseRecipeHead(r.text, "x")!.uses[0];
  assert.deepEqual([u.version, u.commit], ["1.0", head]);
});

test("新規は 1.0 で頭と本文の型を作り、何に使うかが要る", () => {
  assert.deepEqual(writeRecipeText(null, { name: "new-one", uses: [{ skill: "shia2n-zukai-kozo", pin: "now" }] }, ctx()), { ok: false, error: "need_purpose" });
  const r = writeRecipeText(null, { name: "new-one", purpose: "構造図解の試し", uses: [{ skill: "shia2n-zukai-kozo", pin: "now" }, { skill: "shia2n-x-review", pin: "latest" }] }, ctx());
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = parseRecipeHead(r.text, "new-one")!;
  assert.equal(p.name, "new-one");
  assert.equal(p.version, "1.0");
  assert.equal(p.purpose, "構造図解の試し");
  assert.equal(p.uses.length, 2);
  assert.deepEqual(p.bad, []);
});

test("正本の実物のレシピ 2 本を書き直しても、行が全部読める", () => {
  for (const n of ["shia2n-10sen-koboke", "shia2n-kozo-standard"]) {
    let real: string;
    try { real = readFileSync(`/home/claude/shia2n-skills/recipes/${n}/RECIPE.md`, "utf8"); } catch { return; }
    const p = parseRecipeHead(real, n)!;
    const base = ctx();
    for (const u of p.uses) if (!base.skills.has(u.skill)) base.skills.set(u.skill, u.version === "最新" ? "1.0" : u.version); // 正本に足したスキルも読めるように
    const c = { ...base, current: new Map(p.uses.map((u) => [u.skill, { version: u.version, commit: u.commit }])) };
    const r = writeRecipeText(real, { name: n, uses: p.uses.map((u) => ({ skill: u.skill, pin: "keep" as const, strength: u.strength })) }, c);
    assert.ok(r.ok, n);
    if (!r.ok) continue;
    const q = parseRecipeHead(r.text, n)!;
    assert.deepEqual(q.uses.map((u) => [u.skill, u.commit, u.strength]), p.uses.map((u) => [u.skill, u.commit, u.strength]));
    assert.equal(r.text.split("\n---")[1], real.split("\n---")[1]);
  }
});

test("仮説の本文を見出しごとに返す", () => {
  const a = addHypothesis("# 仮説\n", { title: "題1", words: "言葉1", date: "2026-11-16" });
  const b = addHypothesis(a.md, { title: "題2", words: "言葉2", date: "2026-11-16", target: "生徒だけ" });
  const s = hypothesisSections(b.md);
  assert.deepEqual(s.map((x) => [x.id, x.title, x.status]), [[1, "題1", "仮説"], [2, "題2", "仮説"]]);
  assert.match(s[1].body, /誰に当てるか（Naoki の言葉）：生徒だけ/);
  assert.doesNotMatch(s[0].body, /題2/);
});

test("規格 1.0：表示名・ジャンル・カテゴリ・媒体・参照を読む（実物の小ボケ）", async () => {
  const { parseSkillHead, GENRES, CATEGORIES } = await import("../src/skills-core.js");
  let real: string;
  try { real = readFileSync("/home/claude/shia2n-skills/skills/shia2n-koboke/SKILL.md", "utf8"); } catch { return; }
  const m = parseSkillHead(real, "shia2n-koboke")!;
  assert.equal(m.title, "小ボケコメント");
  assert.ok((GENRES as readonly string[]).includes(m.genre!));
  assert.deepEqual(m.category, ["コメント"]);
  assert.deepEqual(m.media, ["X"]);
  assert.deepEqual(m.conflicts, ["shia2n-zukai-kozo"]);
  assert.equal(m.kind, "選択スキル");
  assert.ok(m.category.every((c) => (CATEGORIES as readonly string[]).includes(c)));
  const t = parseSkillHead(`---\nname: a\nmetadata:\n  version: "1"\n  category: "スタイル, 手順"\n  refs: "b、c"\n---\n`, "a")!;
  assert.deepEqual([t.category, t.refs, t.title, t.genre], [["スタイル", "手順"], ["b", "c"], null, null]);
});

test("便 3：前の書き方の流れ（番号つき 1 行）を手順として読む", async () => {
  const { parseFlow } = await import("../src/recipe-write-core.js");
  const f = parseFlow(text);
  assert.deepEqual(f.map((s) => s.title), ["そのまま残る本文"]);
  let real: string;
  try { real = readFileSync("/home/claude/shia2n-skills/recipes/shia2n-10sen-koboke/RECIPE.md", "utf8"); } catch { return; }
  const r = parseFlow(real);
  assert.ok(r.length >= 6); // 実物は手順が増えていく（2026-11-16 に解像度合わせと書き出すを足した）
  assert.ok(r.every((s) => s.title.length > 0));
});

test("便 3：手順（題・説明・スキル・確認・プロンプト）を書いて読み戻すと同じ。ほかの節は残る", async () => {
  const { renderFlow, replaceFlow, parseFlow } = await import("../src/recipe-write-core.js");
  const steps = [
    { title: "項目を決める", detail: "参考と中身を読む\n2 行目", skill: "shia2n-zukai-10sen", check: "シアニンが見る", prompt: "次の参考を読み、\n10 項目を出してください。" },
    { title: "小ボケを出す", skill: "shia2n-koboke" },
    { title: "仕上げ" },
  ];
  const f = renderFlow(steps, new Set(["shia2n-zukai-10sen", "shia2n-koboke"]));
  assert.ok(f.ok);
  if (!f.ok) return;
  const doc = "---\nname: a\n---\n\n# レシピ\n\n## 流れ\n\n1. 古い\n\n## ぶつかったとき\n\n- そのまま\n";
  const out = replaceFlow(doc, f.text);
  assert.match(out, /## ぶつかったとき\n\n- そのまま/);
  assert.doesNotMatch(out, /1\. 古い/);
  const back = parseFlow(out);
  assert.deepEqual(back.map((s) => [s.title, s.detail ?? null, s.skill ?? null, s.check ?? null, s.prompt ?? null]), [
    ["項目を決める", "参考と中身を読む\n2 行目", "shia2n-zukai-10sen", "シアニンが見る", "次の参考を読み、\n10 項目を出してください。"],
    ["小ボケを出す", null, "shia2n-koboke", null, null],
    ["仕上げ", null, null, null, null],
  ]);
});

test("便 3：レシピに無いスキル・題の無い手順・``` 入りのプロンプトは止める", async () => {
  const { renderFlow } = await import("../src/recipe-write-core.js");
  assert.deepEqual(renderFlow([{ title: "a", skill: "x" }], new Set(["y"])), { ok: false, error: "step_skill_not_in_recipe:x" });
  assert.deepEqual(renderFlow([{ title: " " }]), { ok: false, error: "step_no_title:1" });
  assert.deepEqual(renderFlow([{ title: "a", prompt: "```x```" }]), { ok: false, error: "prompt_has_fence:1" });
});

test("便 3：保存で表示名と流れが入り、版が上がる。流れを渡さなければ本文はそのまま", () => {
  const r = writeRecipeText(text, { name: "shia2n-10sen-koboke", title: "10選×小ボケ（強）", uses: [{ skill: "shia2n-koboke", pin: "keep" }], flow: [{ title: "小ボケを出す", skill: "shia2n-koboke", prompt: "3 案出す" }] }, ctx());
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = parseRecipeHead(r.text, "x")!;
  assert.equal(p.title, "10選×小ボケ（強）");
  assert.match(r.text, /### 1\. 小ボケを出す\n- スキル：shia2n-koboke\n\n```プロンプト\n3 案出す\n```/);
  const n = writeRecipeText(text, { name: "shia2n-10sen-koboke", uses: [{ skill: "shia2n-koboke", pin: "keep" }] }, ctx());
  assert.ok(n.ok && n.text.includes("1. そのまま残る本文"));
});

test("便 3：表示名から ID の案", async () => {
  const { slugFrom } = await import("../src/recipe-write-core.js");
  assert.equal(slugFrom("X Review Light"), "x-review-light");
  assert.equal(slugFrom("小ボケ"), null);
  assert.equal(slugFrom("10選 koboke"), "10-koboke");
});

test("「## 流れの決まり」を流れと取り違えない（v1.115.1）", async () => {
  const { parseFlow } = await import("../src/recipe-write-core.ts");
  const t = "---\nname: x\n---\n\n## 流れの決まり\n\n- 止まる\n\n## 流れ\n\n### 1. 描く\n説明\n\n### 2. 組む\n説明\n\n## ぶつかったとき\n\n- x\n";
  const f = parseFlow(t);
  assert.equal(f.length, 2);
  assert.equal(f[0].title, "描く");
});
