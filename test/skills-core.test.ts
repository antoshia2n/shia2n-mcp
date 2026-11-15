// v1.101.0：スキルの正本の読み方。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { filterSkills, groupSkillFiles, nearNames, normWhere, parseSkillHead } from "../src/skills-core.js";

const MD = `---
name: "rumin-youtube-script"
description: "るーみんの台本を作る"
metadata:
  version: "2.1"
  where: "claude.ai, Claude Code"
  audience: "本人, 事業部"
  owner: "るーみん"
  updated: "2026-10-09"
---

# 本文
`;

test("頭の 5 行を読む", () => {
  const m = parseSkillHead(MD, "x")!;
  assert.equal(m.name, "rumin-youtube-script");
  assert.equal(m.version, "2.1");
  assert.deepEqual(m.where, ["claude.ai", "Claude Code"]);
  assert.deepEqual(m.audience, ["本人", "事業部"]);
  assert.equal(m.owner, "るーみん");
  assert.equal(m.updated, "2026-10-09");
  assert.deepEqual(m.missing, []);
});

test("metadata が無いスキルは欠けた欄を返す。頭が無ければ null", () => {
  const m = parseSkillHead("---\nname: a\ndescription: b\n---\nx", "a")!;
  assert.equal(m.version, null);
  assert.deepEqual(m.missing, ["version", "where", "audience", "owner", "updated"]);
  assert.equal(parseSkillHead("# 頭なし", "a"), null);
});

test("木からスキルごとのファイルを並べる（skills/ の外とフォルダは数えない）", () => {
  const g = groupSkillFiles([
    { path: "README.md", type: "blob" },
    { path: "skills/a/SKILL.md", type: "blob" },
    { path: "skills/a/references", type: "tree" },
    { path: "skills/a/references/x.md", type: "blob" },
    { path: "skills/b/SKILL.md", type: "blob" },
  ]);
  assert.deepEqual([...g.keys()], ["a", "b"]);
  assert.deepEqual(g.get("a"), ["SKILL.md", "references/x.md"]);
});

test("使う場所の言い方をそろえて絞る", () => {
  assert.equal(normWhere("ChatGPT"), "GPT");
  assert.equal(normWhere("claude_code"), "Claude Code");
  assert.equal(normWhere("slack"), null);
  const rows = [parseSkillHead(MD, "r")!, { ...parseSkillHead(MD, "g")!, name: "g", where: ["GPT"], owner: "X" }];
  assert.deepEqual(filterSkills(rows, { where: "gpt" }).map((r) => r.name), ["g"]);
  assert.deepEqual(filterSkills(rows, { owner: "るーみん" }).map((r) => r.name), ["rumin-youtube-script"]);
});

test("近い名前", () => {
  assert.deepEqual(nearNames("marketing", ["shia2n-marketing-skills", "x-thread-pipeline"]), ["shia2n-marketing-skills"]);
});
