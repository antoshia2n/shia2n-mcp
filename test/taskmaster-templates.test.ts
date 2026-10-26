import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewTask, newTaskDocFields, withTemplate, templateSummary, nextRepeatTask } from "../src/taskmaster.js";

const tpl = { id: "t1", title: "X分析レポート", keywords: "週次", howto: "数字を取る → 比べる", subtasks: [{ id: "a", title: "数字を取る", done: true }, { text: "比べる" }, "送る", { title: "  " }],
  priority: "high", groupId: "morning", projectId: "x", links: [{ url: "https://mindmap.shia2n.jp/m/1", label: "地図" }, { url: "" }] };

test("テンプレで足す：画面の「テンプレで足す」と同じ中身が入る", () => {
  const body = { title: "今週の X 分析", deadline: "2026-10-27" };
  const t = newTaskDocFields(withTemplate(buildNewTask(body), tpl, body));
  assert.equal(t.templateId, "t1");
  assert.equal(t.howto, "数字を取る → 比べる");
  assert.equal(t.priority, "high");
  assert.equal(t.groupId, "morning");
  assert.equal(t.projectId, "x");
  assert.deepEqual((t.subtasks as any[]).map((s) => [s.title, s.done]), [["数字を取る", false], ["比べる", false], ["送る", false]]);
  assert.deepEqual(t.links, [{ url: "https://mindmap.shia2n.jp/m/1", label: "地図" }]);
  assert.equal(t.deadline, "2026-10-27");
  assert.equal(t.notes, "");
});

test("テンプレで足す：重要度・時間帯・プロジェクトは呼んだ側の指定が先（null で外す指定も守る）", () => {
  const body = { title: "x", priority: "low", groupId: null, projectId: "p" };
  const t = withTemplate(buildNewTask(body), tpl, body);
  assert.equal(t.priority, "low");
  assert.equal(t.groupId, null);
  assert.equal(t.projectId, "p");
});

test("テンプレ無しは今までどおり（チェックとリンクは空・templateId なし）", () => {
  const t = newTaskDocFields(buildNewTask({ title: "x" }));
  assert.deepEqual(t.subtasks, []);
  assert.deepEqual(t.links, []);
  assert.equal("templateId" in t, false);
});

test("一覧の形：チェックは名前だけ・進め方は 300 字まで・重要度は 3 つのどれか", () => {
  const s = templateSummary({ ...tpl, howto: "あ".repeat(400), priority: "urgent" });
  assert.deepEqual(s.subtasks, ["数字を取る", "比べる", "送る"]);
  assert.equal(s.howto.length, 301);
  assert.equal(s.priority, "medium");
});

test("繰り返しのテンプレ付きタスクは、次の回のメモが空（テンプレ無しは持ち越す）", () => {
  const base = { id: "r", title: "郵便", repeat: "weekly", deadline: "2026-10-26", status: "done", completed: true, notes: "この回の記録", subtasks: [] };
  assert.equal(nextRepeatTask({ ...base, templateId: "t1" }, "2026-10-26")!.notes, "");
  assert.equal(nextRepeatTask(base, "2026-10-26")!.notes, "この回の記録");
});
