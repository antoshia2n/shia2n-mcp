import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHaakuManagementOverview, getHaakuStrategyHistory, parseHaakuRoadmap,
  parseHaakuStrategyStore, validAsOfDate,
} from "../src/haaku-plan-summary.ts";

const rawRoadmap = {
  version: 1,
  northStar: "毎朝の現在地を把握する",
  northDetail: "何を優先するかを判断する",
  strategyUrl: "https://whimsical.com/example",
  focusMilestoneId: "m2",
  updatedAt: "2026-10-10T08:00:00.000Z",
  milestones: [
    { id: "m1", title: "募集ページ", criterion: "申込可能", dueDate: "2026-10-20", status: "done", evidence: "https://example.com/a" },
    { id: "m2", title: "イベント企画", criterion: "受付開始", dueDate: "2026-11-10", status: "doing" },
    { id: "m3", title: "2027年の構想", criterion: "計画を決定", dueDate: "2027-01-10", status: "todo" },
    { id: "m4", title: "期限のない案", criterion: "合否を決める", dueDate: "", status: "todo" },
  ],
};

const rawStrategy = {
  schemaVersion: 1,
  records: [{
    id: "s1",
    revisions: [
      { id: "v1", number: 1, savedAt: "2026-09-01T00:00:00.000Z",
        name: "事業A", goal: "理想A", approach: "旧戦略", plan: "旧計画",
        successCriteria: "達成条件", sourceUrl: "https://whimsical.com/old",
        milestoneId: "m1", reason: "初回記録" },
      { id: "v2", number: 2, savedAt: "2026-10-09T00:00:00.000Z",
        name: "事業A", goal: "理想A", approach: "新戦略", plan: "新計画",
        successCriteria: "達成条件", sourceUrl: "https://whimsical.com/new",
        milestoneId: "m2", reason: "検証結果を反映" },
    ],
  }],
};

test("未登録と0件登録済みは明示的に異なる", () => {
  const missing = buildHaakuManagementOverview(
    parseHaakuRoadmap(null), parseHaakuStrategyStore(null), "2026-10-11"
  );
  assert.equal(missing.roadmap.state, "not_configured");
  assert.equal(missing.strategies.state, "not_configured");
  assert.equal(missing.roadmap.quarter.total, null);
  assert.equal(missing.roadmap.quarter.percent, null);
  assert.equal(missing.strategies.count, null);

  const empty = buildHaakuManagementOverview(
    parseHaakuRoadmap({ version: 1, milestones: [] }),
    parseHaakuStrategyStore({ schemaVersion: 1, records: [] }),
    "2026-10-11"
  );
  assert.equal(empty.roadmap.state, "ready");
  assert.equal(empty.strategies.state, "ready");
  assert.equal(empty.roadmap.quarter.total, 0);
  assert.equal(empty.strategies.count, 0);
  assert.equal(empty.roadmap.quarter.percent, null);
});

test("四半期達成は期内のマイルストーンのみ、タスク完了率は使わない", () => {
  const overview = buildHaakuManagementOverview(
    parseHaakuRoadmap(rawRoadmap), parseHaakuStrategyStore(rawStrategy), "2026-10-11"
  );
  assert.deepEqual(overview.roadmap.quarter.months, ["2026-10", "2026-11", "2026-12"]);
  assert.equal(overview.roadmap.quarter.total, 2);
  assert.equal(overview.roadmap.quarter.achieved, 1);
  assert.equal(overview.roadmap.quarter.percent, 50);
  assert.equal(overview.roadmap.total_milestones, 4);
  assert.equal(overview.roadmap.next_milestone?.id, "m2");
  assert.equal(overview.roadmap.next_milestone?.explicitly_selected, true);
  assert.equal(overview.strategies.current[0].approach, "新戦略");
  assert.equal(overview.strategies.current[0].revision_count, 2);
  assert.equal(overview.roadmap.quarter.milestones.some(x => x.id === "m3"), false);
  assert.equal(overview.roadmap.quarter.milestones.some(x => x.id === "m4"), false);
});

test("未選択の重点を選択済みと誤報告しない", () => {
  const overview = buildHaakuManagementOverview(
    parseHaakuRoadmap({ ...rawRoadmap, focusMilestoneId: "m1" }), null, "2026-10-11"
  );
  assert.equal(overview.roadmap.next_milestone?.id, "m2");
  assert.equal(overview.roadmap.next_milestone?.explicitly_selected, false);
});

test("古い版を残したまま変更理由つきで履歴を返す", () => {
  const stored = parseHaakuStrategyStore(rawStrategy);
  const result = getHaakuStrategyHistory(stored, "s1");
  assert.equal(result.found, true);
  if (!result.found) throw Error("history unexpectedly missing");
  assert.equal(result.current_version, 2);
  assert.equal(result.revisions.length, 2);
  assert.equal(result.revisions[0].approach, "新戦略");
  assert.equal(result.revisions[0].change_reason, "検証結果を反映");
  assert.equal(result.revisions[1].approach, "旧戦略");
  assert.equal(getHaakuStrategyHistory(stored, "absent").found, false);
  assert.equal(getHaakuStrategyHistory(null, "s1").state, "not_configured");
});

test("保存形式の誤りは空データとして握りつぶさず拒否する", () => {
  assert.throws(() => parseHaakuRoadmap({ version: 2, milestones: [] }), /版/);
  assert.throws(() => parseHaakuRoadmap(undefined), /形式/);
  assert.throws(() => parseHaakuRoadmap({ ...rawRoadmap, milestones: [{ id: "bad", title: "無効", status: "bogus" }] }), /状態/);
  assert.throws(() => parseHaakuStrategyStore({ schemaVersion: 3, records: [] }), /保存形式/);
  assert.throws(() => parseHaakuStrategyStore({ schemaVersion: 1, records: [{ id: "s", revisions: [] }] }), /改訂履歴/);
  assert.throws(() => parseHaakuStrategyStore({ ...rawStrategy,
    records: [{ ...rawStrategy.records[0], revisions: [{ ...rawStrategy.records[0].revisions[0], number: 7 }] }]
  }), /版番号/);
});

test("日付の境界を厳密にチェックする", () => {
  assert.equal(validAsOfDate("2026-10-11"), "2026-10-11");
  assert.throws(() => validAsOfDate("2026-02-30"), /正しい日付/);
  assert.throws(() => validAsOfDate("2026-1-1"), /YYYY-MM-DD/);
  const dec = buildHaakuManagementOverview(parseHaakuRoadmap(rawRoadmap), null, "2026-12-31");
  assert.equal(dec.roadmap.quarter.total, 2);
  const jan = buildHaakuManagementOverview(parseHaakuRoadmap(rawRoadmap), null, "2027-01-01");
  assert.deepEqual(jan.roadmap.quarter.months, ["2027-01", "2027-02", "2027-03"]);
  assert.equal(jan.roadmap.quarter.total, 1);
  assert.equal(jan.roadmap.quarter.percent, 0);
});
