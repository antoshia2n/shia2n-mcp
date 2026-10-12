/**
 * shia2n-mcp / src/haaku-home.ts / 新設（2026-10-12 v1.10.0 開発部）
 *
 * haAku のホームに出す計算だけを持つ（外に触らないので試験で回せる）。
 * 依頼：https://www.notion.so/3f69c6c1c43981b8bb09fa162e38da9b
 *
 *   すごろくの 1 マス＝ステップ（haAku のマイルストーン）。タスク（TaskMaster）はマスの中。
 *   タスク → ステップの結びは haAku の側（os_task_links_v1）に持つ。
 *
 *   次はこれ   … 詰まりの道（詰まりのマスと、その前のマスの並び）の上で、前のマスが全部 100％ の「動ける」マスの、
 *                未完了の結んだタスクの 1 件目（期限が近い順・期限なしは後ろ）
 *   ここが詰まり … 未完了のマスのうち、dependsOn をたどって後ろにある未完了のマスを一番多く止めている 1 マス。
 *                同数なら期限が近い方（期限なしは後ろ）
 *   行動の率   … 結んだタスクの完了 ÷ 全部（アーカイブして未完了のものは数えない）
 *   成果の率   … 取り組みに結んだ KPI の今月の率（1 本ずつ 100 で頭打ちにして平均）
 *
 * v1.11.0（2026-10-12）：前のマスを複数持てる（dependsOnIds・読み方は haaku-deps.ts）。
 *   動ける … 前へたどれるマスが全部 100％ のときだけ。1 つでも未完了なら待ち
 *   詰まりの数 … 後ろの未完了のマスを 1 マス 1 回だけ数える（複数の前から届いても二重に数えない）
 *   次はこれ … 詰まりのマスと、その前へたどれる全部のマスのうち、動ける未完了のマス。
 *              2 つ以上あれば、後ろを多く止めている方 → 期限が近い方 → ID の順
 */

import { ancestorsOf } from "./haaku-deps.js";

/** dependsOnIds を省くと dependsOn 1 つ（空なら 0 件）として読む（古い呼び出し・試験のため） */
export type Step = { id: string; title: string; status: string; dueDate: string; dependsOn: string; dependsOnIds?: string[]; dependsMismatch?: boolean };
export type Task = { id: string; title: string; completed: boolean; archived: boolean; deadline: string; priority: string };
export type Link = { taskId: string; milestoneId: string };
export type Initiative = { no: string; name: string; linkedMilestoneIds: string[]; linkedKpiIds: string[] };
export type KpiMonth = { id: string; title: string; unit: string; monthlyTarget: number; monthlyActual: number; pct: number | null };

export type StepState = "100%" | "待ち" | "動ける" | "進行中";

const day = (s: string) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "");
const byDue = (a: string, b: string) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);
const rate = (done: number, all: number) => (all > 0 ? Math.round((done / all) * 100) : null);

const idsOf = (s: Step): string[] => s.dependsOnIds ?? (s.dependsOn ? [s.dependsOn] : []);
const depMap = (steps: Map<string, Step>) => new Map([...steps.values()].map(s => [s.id, idsOf(s)]));

/** 前へたどれる全部のマス（近い順・重複なし）。循環していれば止める。見つからない前のマスは無いものとして扱う */
export function predecessors(steps: Map<string, Step>, id: string): string[] {
  return ancestorsOf(depMap(steps), id);
}

/** マスごとの状態と行動の率 */
export function stepRows(stepList: Step[], tasks: Task[], links: Link[]) {
  const steps = new Map(stepList.map(s => [s.id, s]));
  const deps = depMap(steps);
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const linked = new Map<string, Task[]>();
  for (const l of links) {
    const t = taskById.get(l.taskId);
    if (!t || !steps.has(l.milestoneId)) continue;
    if (t.archived && !t.completed) continue;
    (linked.get(l.milestoneId) ?? linked.set(l.milestoneId, []).get(l.milestoneId)!).push(t);
  }
  return stepList.map(s => {
    const ts = linked.get(s.id) ?? [];
    const done = ts.filter(t => t.completed).length;
    const preds = ancestorsOf(deps, s.id);
    const ready = preds.every(p => steps.get(p)!.status === "done");
    const ids = idsOf(s);
    const state: StepState = s.status === "done" ? "100%" :
      !ready || s.status === "blocked" ? "待ち" :
      s.status === "doing" || s.status === "review" || done > 0 ? "進行中" : "動ける";
    return {
      id: s.id, title: s.title, due_date: s.dueDate, status: s.status, state,
      depends_on: ids[0] ?? null,
      depends_on_ids: ids,
      depends_on_missing: ids.some(p => !steps.has(p)),
      depends_on_missing_ids: ids.filter(p => !steps.has(p)),
      ...(s.dependsMismatch ? { depends_on_mismatch: true } : {}),
      tasks_total: ts.length, tasks_done: done, action_pct: rate(done, ts.length),
      open_tasks: ts.filter(t => !t.completed),
    };
  });
}

/** 未完了のマスごとに、後ろにある未完了のマスの数（1 マス 1 回だけ数える） */
function blockCounts(stepList: Step[]): Map<string, number> {
  const steps = new Map(stepList.map(s => [s.id, s]));
  const deps = depMap(steps);
  const open = stepList.filter(s => s.status !== "done");
  const counts = new Map(open.map(s => [s.id, 0]));
  for (const s of open) for (const p of ancestorsOf(deps, s.id)) if (counts.has(p)) counts.set(p, counts.get(p)! + 1);
  return counts;
}

/** ここが詰まり：後ろにある未完了のマスを一番多く止めている未完了のマス */
export function findBlocker(stepList: Step[]): { id: string; blocks: number } | null {
  const counts = blockCounts(stepList);
  const open = stepList.filter(s => s.status !== "done");
  const ranked = [...open].sort((a, b) => (counts.get(b.id)! - counts.get(a.id)!) || byDue(a.dueDate, b.dueDate) || a.id.localeCompare(b.id));
  return ranked.length ? { id: ranked[0].id, blocks: counts.get(ranked[0].id)! } : null;
}

export function computeHome(input: {
  steps: Step[]; tasks: Task[]; links: Link[]; initiatives: Initiative[]; kpis: KpiMonth[]; today: string;
}) {
  const { steps: stepList, tasks, links, initiatives, kpis, today } = input;
  const steps = new Map(stepList.map(s => [s.id, s]));
  const rows = stepRows(stepList, tasks, links);
  const rowById = new Map(rows.map(r => [r.id, r]));
  const blocker = findBlocker(stepList);

  // 次はこれ：詰まりの道の上の、前のマスが全部 100％ の未完了のマス
  let next: Record<string, unknown> = { state: "all_done", note: "未完了のマスがありません" };
  if (blocker) {
    // 詰まりのマスと、その前へたどれる全部のマスのうち、前が全部 100％ の未完了のマス
    const deps = depMap(steps);
    const counts = blockCounts(stepList);
    const path = [blocker.id, ...ancestorsOf(deps, blocker.id)];
    const candidates = path.filter(id => steps.get(id)!.status !== "done" &&
      ancestorsOf(deps, id).every(p => steps.get(p)!.status === "done"));
    const movable = candidates.sort((a, b) => ((counts.get(b) ?? 0) - (counts.get(a) ?? 0)) ||
      byDue(steps.get(a)!.dueDate, steps.get(b)!.dueDate) || a.localeCompare(b))[0];
    const row = rowById.get(movable)!;
    const open = [...row.open_tasks].sort((a, b) => byDue(day(a.deadline), day(b.deadline)) || a.title.localeCompare(b.title, "ja"));
    next = open.length
      ? { state: "task", task: { id: open[0].id, title: open[0].title, deadline: day(open[0].deadline) || null, priority: open[0].priority || null },
          step: { id: row.id, title: row.title, state: row.state } }
      : { state: "no_tasks", note: "タスクが結ばれていない", step: { id: row.id, title: row.title, state: row.state } };
  }

  // 取り組みごと
  const kpiById = new Map(kpis.map(k => [k.id, k]));
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const initiativeRows = initiatives.map(ini => {
    const mids = new Set(ini.linkedMilestoneIds.filter(id => steps.has(id)));
    const ts = links.filter(l => mids.has(l.milestoneId)).map(l => taskById.get(l.taskId))
      .filter((t): t is Task => !!t && !(t.archived && !t.completed));
    const done = ts.filter(t => t.completed).length;
    const ks = ini.linkedKpiIds.map(id => kpiById.get(id)).filter((k): k is KpiMonth => !!k);
    const pcts = ks.map(k => k.pct).filter((p): p is number => p !== null);
    const outcome = pcts.length ? Math.round(pcts.reduce((s, p) => s + Math.min(p, 100), 0) / pcts.length) : null;
    const action = rate(done, ts.length);
    return {
      no: ini.no, name: ini.name,
      steps: [...mids], missing_steps: ini.linkedMilestoneIds.filter(id => !steps.has(id)),
      tasks_total: ts.length, tasks_done: done, action_pct: action,
      outcome_pct: outcome,
      outcome_note: ks.length ? (pcts.length ? null : "結んだ KPI に月の目標がありません") : "KPI が結ばれていない",
      kpis: ks.map(k => ({ id: k.id, title: k.title, unit: k.unit, monthly_target: k.monthlyTarget, monthly_actual: k.monthlyActual, pct: k.pct })),
      missing_kpis: ini.linkedKpiIds.filter(id => !kpiById.has(id)),
      signal: action === 100 && outcome !== null && outcome < 100 ? "打ち手を足す" : null,
    };
  });

  // 期限の数（未完了でアーカイブしていないタスク全部）
  const t = new Date(today + "T00:00:00Z");
  const dow = (t.getUTCDay() + 6) % 7; // 月曜 0
  const nextMon = new Date(t.getTime() + (7 - dow) * 86400000).toISOString().slice(0, 10);
  const nextSun = new Date(t.getTime() + (13 - dow) * 86400000).toISOString().slice(0, 10);
  const openTasks = tasks.filter(x => !x.completed && !x.archived);
  const due = (x: Task) => day(x.deadline);

  return {
    today,
    next,
    blocker: blocker ? { id: blocker.id, title: steps.get(blocker.id)!.title, blocks: blocker.blocks,
      due_date: steps.get(blocker.id)!.dueDate || null, state: rowById.get(blocker.id)!.state } : null,
    steps: rows.map(({ open_tasks, ...r }) => ({ ...r, open_task_ids: open_tasks.map(x => x.id) })),
    initiatives: initiativeRows,
    deadlines: {
      next_week: { from: nextMon, to: nextSun, count: openTasks.filter(x => due(x) >= nextMon && due(x) <= nextSun).length },
      due_by_today_open: openTasks.filter(x => due(x) && due(x) <= today).length,
      open_total: openTasks.length,
      unlinked_open: openTasks.filter(x => !links.some(l => l.taskId === x.id)).length,
    },
  };
}
