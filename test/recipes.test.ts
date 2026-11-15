// v1.105.0：レシピの頭の読み方
import test from "node:test";
import assert from "node:assert/strict";
import { parseRecipeHead, recipeFolders } from "../src/skills-core.js";

const sha = "de1bcffc0668fc320cd6bc838e739a055ed0db42";
const text = `---
name: shia2n-10sen-koboke
metadata:
  version: "1.0"
  purpose: "10選"
  updated: "2026-11-15"
skills:
  - shia2n-koboke@1.1#${sha} | 優先 2 | 強さ 強
  - shia2n-zukai-10sen@1.0#${sha} | 優先 1 | 強さ 標準
  - こわれた行
---

本文`;

test("使うスキルを優先の順に読み、壊れた行は bad に入れる", () => {
  const r = parseRecipeHead(text, "x")!;
  assert.equal(r.name, "shia2n-10sen-koboke");
  assert.equal(r.version, "1.0");
  assert.deepEqual(r.uses.map((u) => [u.skill, u.version, u.priority, u.strength]), [["shia2n-zukai-10sen", "1.0", 1, "標準"], ["shia2n-koboke", "1.1", 2, "強"]]);
  assert.equal(r.uses[0].commit, sha);
  assert.deepEqual(r.bad, ["- こわれた行"]);
});

test("木からレシピの名前を拾う", () => {
  assert.deepEqual(recipeFolders([{ path: "recipes/b/RECIPE.md", type: "blob" }, { path: "recipes/README.md", type: "blob" }, { path: "recipes/a/RECIPE.md", type: "blob" }, { path: "skills/x/SKILL.md", type: "blob" }]), ["a", "b"]);
});
