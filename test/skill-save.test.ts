import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSkillText, similarSkills, stampUpdated } from "../src/skill-save-core.ts";
import { parseSkillHead } from "../src/skills-core.ts";

const make = (o: { name?: string; version?: string; genre?: string; category?: string; refs?: string; body?: string } = {}) => `---
name: ${o.name ?? "shia2n-demo"}
description: "図解の色を決めるときに使う。三人称で書いた説明。"
metadata:
  title: "色の決め方"
  purpose: "図解の色を決める"
  genre: "${o.genre ?? "図解・デザイン"}"
  category: "${o.category ?? "スタイル"}"
  version: "${o.version ?? "1.0"}"
  where: "claude.ai, GPT"
  audience: "本人"
  owner: "コンテンツ制作"
  updated: "2026-01-01"${o.refs ? `\n  refs: "${o.refs}"` : ""}
---

${o.body ?? "# 色の決め方\n\n## 目的\n\n色を決める。\n\n## 使う場面／使わない場面\n\n- 使う：図解\n\n## 手順\n\n1. 決める\n\n## 決まり\n\n- 3 色まで\n\n## 出力の形\n\n- 色の表\n\n## 参照\n\n- なし"}
`;
const other = (name: string, refs = "") => parseSkillHead(make({ name, refs }).replace("色の決め方", name === "shia2n-zukai-10sen" ? "〇〇10選図解" : name), name)!;

test("規格どおりの新しいスキルは通る", () => {
  const c = checkSkillText("shia2n-demo", make(), null, []);
  assert.deepEqual(c.errors, []);
});

test("ジャンル・カテゴリが規格に無いと止まる", () => {
  const c = checkSkillText("shia2n-demo", make({ genre: "クリエイティブ", category: "役割" }), null, []);
  assert.ok(c.errors.some((e) => e.includes("ジャンル「クリエイティブ」")));
  assert.ok(c.errors.some((e) => e.includes("カテゴリ「役割」")));
});

test("見出しが足りない・順が違うと止まる", () => {
  const c1 = checkSkillText("shia2n-demo", make({ body: "# 色\n\n## 目的\n\nx\n\n## 手順\n\n1. y" }), null, []);
  assert.ok(c1.errors.some((e) => e.startsWith("見出しが足りない")));
  const swapped = "# 色\n\n## 手順\n\n1\n\n## 目的\n\nx\n\n## 使う場面／使わない場面\n\nx\n\n## 決まり\n\nx\n\n## 出力の形\n\nx\n\n## 参照\n\nx";
  const c2 = checkSkillText("shia2n-demo", make({ body: swapped }), null, []);
  assert.ok(c2.errors.some((e) => e.startsWith("見出しの順が違う")));
});

test("新しいスキルは 1.0・本文を変えたら版を上げる・頭だけなら上げない", () => {
  assert.ok(checkSkillText("shia2n-demo", make({ version: "1.3" }), null, []).errors.includes("新しいスキルの版は 1.0"));
  const cur = make();
  const changed = make({ body: make().split("---\n").pop()!.replace("3 色まで", "4 色まで") });
  assert.ok(checkSkillText("shia2n-demo", changed, cur, []).errors.some((e) => e.startsWith("本文を変えたので版を上げる")));
  assert.deepEqual(checkSkillText("shia2n-demo", changed.replace('version: "1.0"', 'version: "1.1"'), cur, []).errors, []);
  assert.ok(checkSkillText("shia2n-demo", cur.replace('version: "1.0"', 'version: "1.1"'), cur, []).errors.includes("頭の欄だけの直しでは版を上げない"));
});

test("参照は実在して 1 段まで", () => {
  const a = other("shia2n-a", "shia2n-b");
  const b = other("shia2n-b");
  assert.ok(checkSkillText("shia2n-demo", make({ refs: "shia2n-x" }), null, [a, b]).errors.some((e) => e.includes("参照先「shia2n-x」が正本に無い")));
  assert.ok(checkSkillText("shia2n-demo", make({ refs: "shia2n-a" }), null, [a, b]).errors.some((e) => e.includes("参照は 1 段まで")));
  assert.deepEqual(checkSkillText("shia2n-demo", make({ refs: "shia2n-b" }), null, [a, b]).errors, []);
});

test("updated は今日の日付にそろえる", () => {
  assert.match(stampUpdated(make(), "2026-11-16"), /updated: "2026-11-16"/);
});

test("似たスキルを返す（同じ表示名・目的なら高い点・遠いものは出さない）", () => {
  const K = (name: string, title: string, purpose: string, genre: string) => ({ ...parseSkillHead(make({ name }), name)!, title, purpose, description: purpose, genre });
  const others = [K("shia2n-zukai-10sen", "〇〇10選図解", "番号付きカードで並べる10選の図解を作る", "図解・デザイン"), K("shia2n-invoice", "請求書の作り方", "クライアントに出す請求書を作る", "運営・仕組み")];
  const s = similarSkills({ name: "shia2n-new", title: "〇〇10選図解の青い版", purpose: "10選図解を青い色で作る", description: "番号付きカードで並べる10選の図解を青で作る", genre: "図解・デザイン" }, others);
  assert.equal(s[0].name, "shia2n-zukai-10sen");
  assert.ok(!s.some((x) => x.name === "shia2n-invoice"));
});

test("大きさ：部品（小）は 80 行を超えると注意・手順なら中", async () => {
  const { skillSize, recipeSizeWarning } = await import("../src/skill-save-core.ts");
  assert.equal(skillSize(["スタイル"]), "小");
  assert.equal(skillSize(["スタイル", "手順"]), "中");
  const long = make({ body: "# 色\n\n## 目的\n\nx\n\n## 使う場面／使わない場面\n\nx\n\n## 手順\n\n" + "1. y\n".repeat(90) + "\n## 決まり\n\nx\n\n## 出力の形\n\nx\n\n## 参照\n\nx" });
  assert.ok(checkSkillText("shia2n-demo", long, null, []).warnings.some((w) => w.includes("目安 80 行")));
  const kinds = new Map([["a", "選択スキル"], ["b", "選択スキル"], ["c", "選択スキル"], ["d", "選択スキル"], ["r", "基本スキル"]]);
  assert.equal(recipeSizeWarning(["a", "b", "c", "r"], kinds), null);
  assert.match(recipeSizeWarning(["a", "b", "c", "d", "r"], kinds) || "", /4 本/);
});
