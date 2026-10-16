/**
 * haAku の実データから読み取り専用の経営文脈を組み立てる。
 * 画面が使用している保存形式だけを受け付け、未知の形式は止める。
 * 取得不能と未登録を同一視しないため、入力の null は「文書が404」専用。
 */

import { depsOf } from "./haaku-deps.js";

type ObjectRow = Record<string, unknown>;

export type MilestoneState = "todo" | "doing" | "review" | "blocked" | "done";

export interface HaakuMilestone {
  id: string;
  title: string;
  criterion: string;
  dueDate: string;
  status: MilestoneState;
  area: string;
  owner: string;
  projectId: string;
  notionUrl: string;
  dependsOn: string;
  /** v1.11.0：前のマスの並び（haaku-deps.ts の depsOf で読んだもの）。dependsOn は 1 つ目 */
  dependsOnIds: string[];
  dependsMismatch: boolean;
  evidence: string;
  /** v1.14.0：着手日（YYYY-MM-DD・空可）。日付として読めない値なら空にして startDateBad を立てる（写す側はそのマスに触らない） */
  startDate: string;
  startDateBad: boolean;
  /** v1.14.0：メモ（文章）とリンク（{ title, url } の並び）。形が違う項目は読まずに linksBad に数える */
  notes: string;
  links: { title: string; url: string }[];
  linksBad: number;
  /** v1.19.0：所属フェーズの id（os_roadmap_v1 の phases[].id・空可） */
  phaseId: string;
}

/** v1.19.0：フェーズ（os_roadmap_v1 の phases）。書くのは preview／apply の kind phase と haAku の画面 */
export interface HaakuPhase {
  id: string;
  title: string;
  purpose: string;
  startDate: string;
  dueDate: string;
  /** 日付として読めない値は空にして印を立てる（フェーズ全体は止めない） */
  datesBad: boolean;
  projectId: string;
  order: number | null;
}

/** v1.14.0：マスの links を読む。形が違う項目は落として数だけ返す（ロードマップ全体を止めない） */
export function milestoneLinksOf(raw: unknown): { links: { title: string; url: string }[]; bad: number } {
  if (raw === undefined || raw === null) return { links: [], bad: 0 };
  if (!Array.isArray(raw)) return { links: [], bad: 1 };
  const links: { title: string; url: string }[] = [];
  let bad = 0;
  for (const x of raw) {
    const o = x as Record<string, unknown>;
    if (o && typeof o === "object" && !Array.isArray(o) && typeof o.url === "string" && o.url &&
        (o.title === undefined || typeof o.title === "string")) links.push({ title: (o.title as string | undefined) ?? "", url: o.url });
    else bad++;
  }
  return { links, bad };
}

export interface HaakuRoadmap {
  version: 1;
  northStar: string;
  northDetail: string;
  strategyUrl: string;
  focusMilestoneId: string;
  updatedAt: string;
  milestones: HaakuMilestone[];
  /**
   * v1.19.0：phases の欄そのまま。読むのは buildHaakuManagementOverview の parsePhases だけ。
   * ここで読むと、フェーズの形が崩れたときに get_home・期限の写し・その日の記録まで止まるため
   */
  phasesRaw: unknown;
}

export interface HaakuStrategyRevision {
  id: string;
  number: number;
  savedAt: string;
  name: string;
  goal: string;
  approach: string;
  plan: string;
  successCriteria: string;
  sourceUrl: string;
  milestoneId: string;
  reason: string;
}

export interface HaakuStrategyRecord {
  id: string;
  revisions: HaakuStrategyRevision[];
}

export interface HaakuStrategyStore {
  schemaVersion: 1;
  records: HaakuStrategyRecord[];
}

function objectOf(input: unknown, where: string): ObjectRow {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(where + " の形式が不明です。推測して空として扱いません");
  }
  return input as ObjectRow;
}

function optionalText(input: unknown, where: string): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new Error(where + " が文字列ではありません");
  return input;
}

function requiredText(input: unknown, where: string): string {
  const val = optionalText(input, where);
  if (val.trim() === "") throw new Error(where + " が空です");
  return val;
}

export function validAsOfDate(day: string): string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("基準日は YYYY-MM-DD の形で指定してください");
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const d = new Date(Date.UTC(year, month - 1, date));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== date) {
    throw new Error("基準日の値が正しい日付ではありません");
  }
  return day;
}

/** v1.14.0：着手日は画面が書く新しい欄。読めない値でロードマップ全体を止めず、そのマスだけ印を立てる */
function startOf(raw: unknown): { startDate: string; startDateBad: boolean } {
  if (raw === undefined || raw === null || raw === "") return { startDate: "", startDateBad: false };
  if (typeof raw === "string") { try { return { startDate: validAsOfDate(raw), startDateBad: false }; } catch { /* 下へ */ } }
  return { startDate: "", startDateBad: true };
}

export function parseHaakuRoadmap(input: unknown): HaakuRoadmap | null {
  if (input === null) return null;
  const raw = objectOf(input, "ロードマップ");
  if (raw.version !== 1 || !Array.isArray(raw.milestones)) {
    throw new Error("ロードマップの版・マイルストーン形式が一致しません（os_roadmap_v1）");
  }
  const milestones: HaakuMilestone[] = raw.milestones.map((x, index) => {
    const r = objectOf(x, "マイルストーン " + (index + 1));
    const id = requiredText(r.id, "マイルストーンid");
    const title = requiredText(r.title, "マイルストーン名");
    if (r.status !== "todo" && r.status !== "doing" &&
        r.status !== "review" && r.status !== "blocked" && r.status !== "done") {
      throw new Error("マイルストーン「" + title + "」の状態が不明です");
    }
    const dueDate = optionalText(r.dueDate, "期限");
    if (dueDate) validAsOfDate(dueDate);
    if (r.dependsOnIds !== undefined &&
        (!Array.isArray(r.dependsOnIds) || r.dependsOnIds.some(v => typeof v !== "string"))) {
      throw new Error("マイルストーン「" + title + "」の前のマス（dependsOnIds）が文字列の配列ではありません");
    }
    const deps = depsOf({ dependsOn: optionalText(r.dependsOn, "依存関係"), dependsOnIds: r.dependsOnIds });
    return {
      id, title,
      criterion: optionalText(r.criterion, "合格条件"),
      dueDate, status: r.status,
      area: optionalText(r.area, "領域"),
      owner: optionalText(r.owner, "担当"),
      projectId: optionalText(r.projectId, "プロジェクトID"),
      notionUrl: optionalText(r.notionUrl, "関連資料"),
      dependsOn: optionalText(r.dependsOn, "依存関係"),
      dependsOnIds: deps.ids,
      dependsMismatch: deps.mismatch,
      evidence: optionalText(r.evidence, "証拠"),
      ...startOf(r.startDate),
      notes: typeof r.notes === "string" ? r.notes : "",
      ...(() => { const l = milestoneLinksOf(r.links); return { links: l.links, linksBad: l.bad }; })(),
      // v1.19.0：ほかの道具（get_home・期限の写し）も通る所なので、形が違っても止めずに空にする
      phaseId: typeof r.phaseId === "string" ? r.phaseId : "",
    };
  });
  if (new Set(milestones.map(x => x.id)).size !== milestones.length) {
    throw new Error("マイルストーンIDが重複しています");
  }
  return {
    version: 1,
    northStar: optionalText(raw.northStar, "北極星"),
    northDetail: optionalText(raw.northDetail, "北極星の説明"),
    strategyUrl: optionalText(raw.strategyUrl, "戦略URL"),
    focusMilestoneId: optionalText(raw.focusMilestoneId, "重点ID"),
    updatedAt: optionalText(raw.updatedAt, "更新日時"),
    milestones,
    phasesRaw: raw.phases,
  };
}

/** v1.19.0：日付の欄。空は空、読めない値は空にして bad を立てる */
function phaseDateOf(raw: unknown): { value: string; bad: boolean } {
  if (raw === undefined || raw === null || raw === "") return { value: "", bad: false };
  if (typeof raw === "string") { try { return { value: validAsOfDate(raw), bad: false }; } catch { /* 下へ */ } }
  return { value: "", bad: true };
}

/**
 * v1.19.0：フェーズを読む。欄が無い（undefined・null）は 0 件。
 * 並びでない・id か題名が無い・id が重なる、は 0 件と区別するため止める。
 */
export function parsePhases(input: unknown): HaakuPhase[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("フェーズ（os_roadmap_v1 の phases）が並びではありません。0 件とは区別して中断しました");
  const phases = input.map((x, index) => {
    const r = objectOf(x, "フェーズ " + (index + 1));
    const id = requiredText(r.id, "フェーズid");
    const title = requiredText(r.title, "フェーズ名");
    const start = phaseDateOf(r.startDate), due = phaseDateOf(r.dueDate);
    return {
      id, title,
      purpose: optionalText(r.purpose, "フェーズ「" + title + "」の目的"),
      startDate: start.value, dueDate: due.value, datesBad: start.bad || due.bad,
      projectId: optionalText(r.projectId, "フェーズ「" + title + "」のプロジェクトID"),
      order: typeof r.order === "number" && Number.isFinite(r.order) ? r.order : null,
    };
  });
  if (new Set(phases.map(x => x.id)).size !== phases.length) throw new Error("フェーズIDが重複しています");
  return phases;
}

/** v1.19.0：並び順（order → 開始日 → 期限 → 題名） */
function sortPhases(items: HaakuPhase[]): HaakuPhase[] {
  return [...items].sort((a, b) =>
    (a.order ?? 1e9) - (b.order ?? 1e9) ||
    (a.startDate || "9999-12-31").localeCompare(b.startDate || "9999-12-31") ||
    (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") ||
    a.title.localeCompare(b.title, "ja")
  );
}

export function parseHaakuStrategyStore(input: unknown): HaakuStrategyStore | null {
  if (input === null) return null;
  const raw = objectOf(input, "戦略");
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.records)) {
    throw new Error("戦略の保存形式が一致しません（os_strategy_records_v1）");
  }
  const revisionIds = new Set<string>();
  const records: HaakuStrategyRecord[] = raw.records.map((inputRecord, i) => {
    const row = objectOf(inputRecord, "戦略 " + (i + 1));
    const id = requiredText(row.id, "戦略ID");
    if (!Array.isArray(row.revisions) || row.revisions.length === 0) {
      throw new Error("戦略「" + id + "」の改訂履歴が不明です");
    }
    const revisions: HaakuStrategyRevision[] = row.revisions.map((rawRev, index) => {
      const rev = objectOf(rawRev, "改訂 " + (index + 1));
      const versionId = requiredText(rev.id, "改訂ID");
      if (rev.number !== index + 1) throw new Error("戦略「" + id + "」の版番号が一致しません");
      if (revisionIds.has(versionId)) throw new Error("改訂IDが重複しています");
      revisionIds.add(versionId);
      const savedAt = requiredText(rev.savedAt, "改訂日時");
      if (!Number.isFinite(Date.parse(savedAt))) throw new Error("改訂日時の形式が不正です");
      return {
        id: versionId,
        number: index + 1,
        savedAt,
        name: requiredText(rev.name, "戦略対象"),
        goal: requiredText(rev.goal, "目的"),
        approach: requiredText(rev.approach, "戦略・方針"),
        plan: requiredText(rev.plan, "計画"),
        successCriteria: requiredText(rev.successCriteria, "検証条件"),
        sourceUrl: requiredText(rev.sourceUrl, "元資料URL"),
        milestoneId: optionalText(rev.milestoneId, "マイルストーンID"),
        reason: optionalText(rev.reason, "改訂理由"),
      };
    });
    return { id, revisions };
  });
  if (new Set(records.map(x => x.id)).size !== records.length) {
    throw new Error("戦略IDが重複しています");
  }
  return { schemaVersion: 1, records };
}

const order: Record<MilestoneState, number> = {
  doing: 0, review: 1, blocked: 2, todo: 3, done: 4,
};

function sortUpcoming(items: HaakuMilestone[]): HaakuMilestone[] {
  return [...items].sort((a, b) =>
    order[a.status] - order[b.status] ||
    (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") ||
    a.title.localeCompare(b.title, "ja")
  );
}

function makeMilestoneView(item: HaakuMilestone, day: string) {
  return {
    id: item.id, title: item.title, status: item.status,
    criterion: item.criterion, due_date: item.dueDate || null,
    area: item.area || null, owner: item.owner || null,
    project_id: item.projectId || null, depends_on: item.dependsOnIds[0] ?? null,
    depends_on_ids: item.dependsOnIds,
    source_url: item.notionUrl || null,
    evidence: item.evidence || null,
    start_date: item.startDate || null,
    notes: item.notes || null,
    links: item.links,
    phase_id: item.phaseId || null,
    ...(item.startDateBad ? { start_date_unreadable: true } : {}),
    ...(item.linksBad ? { links_unreadable: item.linksBad } : {}),
    overdue: !!item.dueDate && item.dueDate < day && item.status !== "done",
  };
}

export function buildHaakuManagementOverview(
  roadmap: HaakuRoadmap | null,
  strategy: HaakuStrategyStore | null,
  asOf: string
) {
  const day = validAsOfDate(asOf);
  const year = Number(day.slice(0, 4));
  const firstMonth = Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1;
  const monthKeys = Array.from({ length: 3 }, (_, index) =>
    String(year) + "-" + String(firstMonth + index).padStart(2, "0")
  );
  const all = roadmap?.milestones ?? [];
  // v1.19.0：フェーズの形が崩れていたら、ここで止める（0 件と区別するため）
  const phases = roadmap ? parsePhases(roadmap.phasesRaw) : [];
  const thisQuarter = all.filter(item => monthKeys.some(key => item.dueDate.startsWith(key)));
  const finished = thisQuarter.filter(item => item.status === "done").length;
  const active = sortUpcoming(all.filter(item => item.status !== "done"));
  const chosen = active.find(item => item.id === roadmap?.focusMilestoneId) || active[0] || null;
  const current = strategy?.records.map(record => {
    const rev = record.revisions[record.revisions.length - 1];
    return {
      record_id: record.id,
      name: rev.name,
      version: rev.number,
      saved_at: rev.savedAt,
      goal: rev.goal,
      approach: rev.approach,
      plan: rev.plan,
      success_criteria: rev.successCriteria,
      source_url: rev.sourceUrl,
      milestone_id: rev.milestoneId || null,
      latest_change_reason: rev.reason,
      revision_count: record.revisions.length,
    };
  }) || [];
  return {
    ok: true,
    as_of_jst: day,
    roadmap: {
      state: roadmap ? "ready" : "not_configured",
      version: roadmap?.version ?? null,
      north_star: roadmap?.northStar ?? null,
      north_detail: roadmap?.northDetail ?? null,
      strategy_source_url: roadmap?.strategyUrl ?? null,
      updated_at: roadmap?.updatedAt || null,
      total_milestones: roadmap ? all.length : null,
      total_unfinished: roadmap ? active.length : null,
      quarter: {
        months: monthKeys,
        total: roadmap ? thisQuarter.length : null,
        achieved: roadmap ? finished : null,
        percent: roadmap && thisQuarter.length ? Math.round(finished / thisQuarter.length * 100) : null,
        by_month: monthKeys.map(key => {
          const rows = thisQuarter.filter(item => item.dueDate.startsWith(key));
          return {
            month: key,
            total: roadmap ? rows.length : null,
            achieved: roadmap ? rows.filter(item => item.status === "done").length : null,
          };
        }),
        milestones: thisQuarter.map(row => makeMilestoneView(row, day)),
      },
      phases: {
        state: roadmap ? "ready" : "not_configured",
        count: roadmap ? phases.length : null,
        items: sortPhases(phases).map(p => {
          const rows = all.filter(m => m.phaseId === p.id);
          return {
            id: p.id, title: p.title, purpose: p.purpose || null,
            start_date: p.startDate || null, due_date: p.dueDate || null,
            project_id: p.projectId || null, order: p.order,
            milestones_total: rows.length,
            milestones_achieved: rows.filter(m => m.status === "done").length,
            ...(p.datesBad ? { dates_unreadable: true } : {}),
          };
        }),
        milestones_without_phase: roadmap ? all.filter(m => !m.phaseId).length : null,
        milestones_with_unknown_phase: roadmap
          ? all.filter(m => m.phaseId && !phases.some(p => p.id === m.phaseId)).length : null,
      },
      next_milestone: chosen ? {
        ...makeMilestoneView(chosen, day),
        explicitly_selected: chosen.id === roadmap?.focusMilestoneId,
      } : null,
    },
    strategies: {
      state: strategy ? "ready" : "not_configured",
      count: strategy ? current.length : null,
      current,
    },
    note: "達成は成果物の合格で判定。タスク完了率は使わない。戦略・計画はhaAkuで人が確定した版のみ。",
  };
}

export function getHaakuStrategyHistory(strategy: HaakuStrategyStore | null, recordId: string) {
  const id = recordId.trim();
  if (!id) throw new Error("戦略IDは必須です");
  if (!strategy) return { ok: true, state: "not_configured", found: false, record_id: id, revisions: [] };
  const item = strategy.records.find(row => row.id === id);
  if (!item) return { ok: true, state: "ready", found: false, record_id: id, revisions: [] };
  return {
    ok: true, state: "ready", found: true, record_id: id,
    current_version: item.revisions.length,
    revisions: [...item.revisions].reverse().map(rev => ({
      id: rev.id, version: rev.number, saved_at: rev.savedAt,
      name: rev.name, goal: rev.goal, approach: rev.approach, plan: rev.plan,
      success_criteria: rev.successCriteria, source_url: rev.sourceUrl,
      milestone_id: rev.milestoneId || null,
      change_reason: rev.reason,
    })),
  };
}
