/**
 * shia2n-mcp / src/haaku-initiatives.ts / 新設（2026-10-11 v1.9.0 開発部）
 *
 * haAku の「取り組み」（2026 年の 13 の取り組み）の正本。
 * 依頼：https://www.notion.so/3f69c6c1c43981078ffddb4e003925ee（統括 2026-10-11 20:05：戦略とは別の文書に持つ）
 *
 * 置き場：users/{uid}/app_data/os_initiatives_v1（1 文書）
 *   { schemaVersion: 1, records: [{ id: "initiative_01", initiativeNo: "01", revisions: [版, …] }], updatedAt }
 *   版：{ id, number, savedAt, requestId, source, reason, name, stage, overview,
 *         ideals, conditions, kpis, approaches, plans, obstacles（どれも [{ text, theme }]・theme は空を許す）,
 *         progress, linkedMilestoneIds, linkedKpiIds, taskmasterProjectId }
 *   taskmasterProjectId（v1.12.0）：組にする TaskMaster のプロジェクト（users/{uid}/app_data/projects の id）。空なら組なし。
 *     1 つのプロジェクトは 1 つの取り組みにだけ（束を当て終えた形で確かめる）。付けるときはプロジェクトが在って status が active のこと
 *
 * 書き込みは戦略と同じ承認の流れ（preview → haAku の画面で本人が承認 → apply）だけ。
 * 改訂のたびに版が 1 つ増え、2 版目からは理由が要る。中身が同じなら断る。
 *
 * 結び（マイルストーン・KPI）は取り組みの側に持つ。
 *   マイルストーン（os_roadmap_v1）と KPI（os_kpis）の文書は haAku の画面も書くため、
 *   そちらに新しい欄を足すと、画面が知らない欄を落としたときに結びが黙って消える。取り組みの側なら消えない。
 *   マイルストーン・KPI から取り組みの番号を引くのは、読む道具（haAku__get_initiatives）が逆引きで返す。
 */
import type { Change } from "./haaku-ai-changes.js";

type Obj = Record<string, unknown>;
type Item = Record<string, unknown>;
export type InitiativeEntry = { text: string; theme: string };
export type InitiativeStepView = {
  kind: "initiative"; action: "create" | "update";
  id: string; title: string; before: Obj | null; after: Obj;
};

export const INITIATIVES_KEY = "os_initiatives_v1";
export const STAGES = ["整える", "時間を作る", "構築する"] as const;
export const LIST_FIELDS = ["ideals", "conditions", "kpis", "approaches", "plans", "obstacles"] as const;
const LIST_LABEL: Record<string, string> = {
  ideals: "理想", conditions: "条件", kpis: "KPI", approaches: "アプローチ", plans: "計画", obstacles: "障害対策",
};
const TEXT_LIMIT: Record<string, number> = { name: 90, overview: 1200, progress: 300, reason: 600 };
const MAX_ITEMS = 40;
const MAX_TEXT = 600;
const MAX_THEME = 80;
const MAX_LINKS = 30;
const NO = /^(0[1-9]|[1-9][0-9])$/;
const REF = /^[A-Za-z0-9_-]{1,180}$/;

const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).byteLength;

export function initiativeId(no: string): string {
  return "initiative_" + no;
}

/** 文書を読む。無ければ空。形が違えば止める（空とみなさない） */
export function initiativeStore(value: unknown): Obj {
  if (value === null || value === undefined) return { schemaVersion: 1, records: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("取り組みの保存形式が不正です。変更を停止しました");
  }
  const out = value as Obj;
  if (out.schemaVersion !== 1) throw new Error("取り組みの版が不一致です");
  const records = out.records;
  if (!Array.isArray(records) || records.some(r => !r || typeof r !== "object" || Array.isArray(r))) {
    throw new Error("取り組みの一覧を確認できません。変更を停止しました");
  }
  const rows = records as Item[];
  if (new Set(rows.map(r => r.id)).size !== rows.length ||
      rows.some(r => !NO.test(str(r.initiativeNo)) || r.id !== initiativeId(str(r.initiativeNo)) ||
        !Array.isArray(r.revisions) || !r.revisions.length)) {
    throw new Error("取り組みの番号または版の並びが不正です");
  }
  return { ...out, records: rows };
}

/** 一覧の欄（JSON の文字列）を [{ text, theme }] に直す。文字だけの要素はテーマ無しとして受ける */
export function parseEntries(raw: string, field: string): InitiativeEntry[] {
  const label = LIST_LABEL[field] ?? field;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(label + "は JSON の配列（[{\"text\":\"…\",\"theme\":\"…\"}]）で渡してください"); }
  if (!Array.isArray(parsed)) throw new Error(label + "は配列で渡してください");
  if (parsed.length > MAX_ITEMS) throw new Error(label + "は " + MAX_ITEMS + " 項目までです");
  return parsed.map((v, i): InitiativeEntry => {
    const o = typeof v === "string" ? { text: v } : v;
    if (!o || typeof o !== "object" || Array.isArray(o) ||
        Object.keys(o).some(k => k !== "text" && k !== "theme")) {
      throw new Error(label + "の " + (i + 1) + " 項目めは { text, theme } の形にしてください");
    }
    const text = str((o as Obj).text), theme = str((o as Obj).theme);
    if (!text) throw new Error(label + "の " + (i + 1) + " 項目めが空です");
    if (text.length > MAX_TEXT) throw new Error(label + "の " + (i + 1) + " 項目めは " + MAX_TEXT + " 文字以内にしてください");
    if (theme.length > MAX_THEME) throw new Error(label + "の " + (i + 1) + " 項目めのテーマは " + MAX_THEME + " 文字以内にしてください");
    return { text, theme };
  });
}

function parseIds(raw: string, label: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(label + "は JSON の配列（[\"id\", …]）で渡してください"); }
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string" || !REF.test(v))) {
    throw new Error(label + "は ID の文字列の配列で渡してください");
  }
  if (parsed.length > MAX_LINKS) throw new Error(label + "は " + MAX_LINKS + " 件までです");
  if (new Set(parsed).size !== parsed.length) throw new Error(label + "に同じ ID が重複しています");
  return parsed as string[];
}

function entriesText(list: unknown): string {
  if (!Array.isArray(list)) return "";
  return (list as InitiativeEntry[]).map(e => "・" + (e.theme ? "［" + e.theme + "］" : "") + e.text).join("\n");
}

function linksText(ids: unknown, rows: Item[]): string {
  if (!Array.isArray(ids)) return "";
  return (ids as string[]).map(id => {
    const row = rows.find(r => r.id === id);
    return (row ? str(row.title) : "（見つからない）") + "（" + id + "）";
  }).join("\n");
}

/** 承認の画面で読める形（一覧は 1 行ずつの文字、結びは名前つき）に直す。保存する中身は配列のまま */
function display(rev: Obj | null, milestones: Item[], kpis: Item[], projects: Item[] = []): Obj | null {
  if (!rev) return null;
  const out: Obj = { ...rev };
  for (const f of LIST_FIELDS) out[f] = entriesText(rev[f]);
  out.linkedMilestoneIds = linksText(rev.linkedMilestoneIds, milestones);
  out.linkedKpiIds = linksText(rev.linkedKpiIds, kpis);
  // v1.12.0：承認の画面では「名前（id）」で見せる。古い版で欄が無ければ空として扱う（空同士なら差分に出ない）
  const pid = str(rev.taskmasterProjectId);
  out.taskmasterProjectId = pid ? linksText([pid], projects) : "";
  return out;
}

/** v1.12.0：TaskMaster のプロジェクト一覧（app_data/projects の value）を配列として読む。無ければ null */
export function projectList(raw: unknown): Item[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some(p => !p || typeof p !== "object" || Array.isArray(p))) {
    throw new Error("TaskMaster のプロジェクト一覧の形が読めません。変更を停止しました");
  }
  return raw as Item[];
}

/** v1.12.0：付けるプロジェクトを確かめる（在る・進行中）。外すとき（空）は確かめない */
function checkProject(id: string, projects: Item[] | null): void {
  if (!id) return;
  if (!REF.test(id)) throw new Error("taskmasterProjectId の形が不正です：" + id);
  if (projects === null) throw new Error("TaskMaster のプロジェクト一覧が読めません（文書が無い）。付けずに止めました");
  const p = projects.find(x => str(x.id) === id);
  if (!p) throw new Error("TaskMaster に無いプロジェクトです：" + id);
  if (str(p.status) !== "active") {
    throw new Error("進行中でないプロジェクトです：" + str(p.title) + "（" + id + "・status " + (str(p.status) || "空") + "）");
  }
}

/**
 * v1.12.0：束を当て終えた形で、1 つのプロジェクトが 2 つ以上の取り組みの現在の版に付いていないかを確かめる。
 * buildManagementChangePlan が束の最後に 1 回だけ呼ぶ（同じ束で A から外して B に付ける付け替えを通すため）
 */
export function assertUniqueProjects(raw: unknown, projects: Item[] = []): void {
  if (raw === null || raw === undefined) return;
  const doc = initiativeStore(raw);
  const owner = new Map<string, string[]>();
  for (const r of doc.records as Item[]) {
    const pid = str(((r.revisions as Obj[]).at(-1) as Obj).taskmasterProjectId);
    if (pid) (owner.get(pid) ?? owner.set(pid, []).get(pid)!).push(str(r.initiativeNo));
  }
  const dup = [...owner].filter(([, nos]) => nos.length > 1);
  if (dup.length) {
    throw new Error("1 つのプロジェクトは 1 つの取り組みにだけ付けられます：" + dup.map(([pid, nos]) =>
      linksText([pid], projects) + " ← 取り組み " + nos.join("・")).join("／"));
  }
}

function sameContent(a: Obj, b: Obj): boolean {
  const keys = ["name", "stage", "overview", "progress", ...LIST_FIELDS, "linkedMilestoneIds", "linkedKpiIds"];
  // v1.12.0：taskmasterProjectId は欄が無い古い版と空を同じとみなす
  return keys.every(k => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null)) &&
    str(a.taskmasterProjectId) === str(b.taskmasterProjectId);
}

/** 取り組み 1 件を新規または改訂する（state を書き換える）。マイルストーンと KPI は読むだけ */
export function writeInitiative(
  state: Record<string, unknown>, op: Change, at: string, milestones: Item[], kpis: Item[],
  projects: Item[] | null = null,
): InitiativeStepView {
  const doc = initiativeStore(state[INITIATIVES_KEY]);
  const records = doc.records as Item[];
  const no = str(op.data.initiativeNo);
  if (!NO.test(no)) throw new Error("取り組みの番号は 01〜99 の 2 桁で渡してください");
  const id = initiativeId(no);
  const current = records.find(r => r.id === id);
  const revisions = (current?.revisions || []) as Obj[];
  if (records.some(r => (r.revisions as Obj[]).some(rev => rev.id === "ai_revision_" + op.request_id))) {
    throw new Error("同じ操作IDが取り組みの版に既に存在します");
  }
  const previous = revisions.length ? revisions[revisions.length - 1] : null;

  const next: Obj = {};
  for (const [key, max] of Object.entries(TEXT_LIMIT)) {
    if (key === "reason") continue;
    const v = op.data[key] !== undefined ? str(op.data[key]) : str(previous?.[key]);
    if (v.length > max) throw new Error(key + " は " + max + " 文字以内にしてください");
    next[key] = v;
  }
  next.stage = op.data.stage !== undefined ? str(op.data.stage) : str(previous?.stage);
  for (const f of LIST_FIELDS) {
    next[f] = op.data[f] !== undefined ? parseEntries(op.data[f], f) : (previous?.[f] ?? []);
  }
  next.linkedMilestoneIds = op.data.linkedMilestoneIds !== undefined ?
    parseIds(op.data.linkedMilestoneIds, "結ぶマイルストーン") : (previous?.linkedMilestoneIds ?? []);
  next.linkedKpiIds = op.data.linkedKpiIds !== undefined ?
    parseIds(op.data.linkedKpiIds, "結ぶ KPI") : (previous?.linkedKpiIds ?? []);
  // v1.12.0：指定が無ければ前の版の値を引き継ぐ。指定があるときだけ確かめる（在る・進行中）。重なりは束の最後に見る
  if (op.data.taskmasterProjectId !== undefined) {
    next.taskmasterProjectId = str(op.data.taskmasterProjectId);
    checkProject(str(next.taskmasterProjectId), projects);
  } else {
    next.taskmasterProjectId = str(previous?.taskmasterProjectId);
  }

  if (!next.name) throw new Error("取り組みの名前が必要です");
  if (!(STAGES as readonly string[]).includes(str(next.stage))) {
    throw new Error("段階は「整える」「時間を作る」「構築する」のどれかにしてください");
  }
  for (const mid of next.linkedMilestoneIds as string[]) {
    if (!milestones.some(m => m.id === mid)) throw new Error("結ぶマイルストーンが見つかりません：" + mid);
  }
  for (const kid of next.linkedKpiIds as string[]) {
    if (!kpis.some(k => k.id === kid)) throw new Error("結ぶ KPI が見つかりません：" + kid);
  }
  if (records.some(r => r.id !== id &&
      str(((r.revisions as Obj[]).at(-1))?.name).toLocaleLowerCase("ja") === str(next.name).toLocaleLowerCase("ja"))) {
    throw new Error("同じ名前の取り組みが別の番号で登録済みです");
  }
  const reason = str(op.data.reason);
  if (reason.length > TEXT_LIMIT.reason) throw new Error("理由は " + TEXT_LIMIT.reason + " 文字以内にしてください");
  if (previous) {
    // 前の理由を使い回さない。改訂のたびに新しい理由が要る
    if (!reason) throw new Error("取り組みの改訂には理由が必要です");
    if (sameContent(previous, next)) throw new Error("前の版と中身が変わっていません");
  }

  const revision: Obj = {
    id: "ai_revision_" + op.request_id, number: revisions.length + 1, savedAt: at,
    requestId: op.request_id, source: "approved_mcp_change",
    reason: previous ? reason : (reason || "初回記録"),
    ...next,
  };
  const record = current ? { ...current, revisions: [...revisions, revision] } :
    { id, initiativeNo: no, revisions: [revision] };
  doc.records = (current ? records.map(r => r.id === id ? record : r) : [...records, record])
    .sort((a, b) => str((a as Item).initiativeNo).localeCompare(str((b as Item).initiativeNo)));
  doc.updatedAt = at;
  if (bytes(doc) > 700000) throw new Error("取り組みの保存容量が上限に達しました");
  state[INITIATIVES_KEY] = doc;
  return {
    kind: "initiative", action: current ? "update" : "create", id,
    title: no + " " + str(next.name),
    before: display(previous, milestones, kpis, projects ?? []), after: display(revision, milestones, kpis, projects ?? []) as Obj,
  };
}

/**
 * v1.11.0：マイルストーンを消すとき、それを結んでいる取り組みから外す（取り組みごとに版を 1 つ上げる）。
 * 結んでいる取り組みが無ければ何もしない（文書も書き換えない）。milestones は消す前の一覧（承認の画面で名前を出すため）
 */
export function unlinkMilestone(
  state: Record<string, unknown>, milestoneId: string, milestoneTitle: string,
  requestId: string, reason: string, at: string, milestones: Item[], kpis: Item[],
): InitiativeStepView[] {
  const raw = state[INITIATIVES_KEY];
  if (raw === null || raw === undefined) return [];
  const doc = initiativeStore(raw);
  const records = doc.records as Item[];
  const views: InitiativeStepView[] = [];
  const next = records.map(r => {
    const revisions = r.revisions as Obj[];
    const previous = revisions.at(-1) as Obj;
    const linked = (previous.linkedMilestoneIds as string[] | undefined) ?? [];
    if (!linked.includes(milestoneId)) return r;
    const no = str(r.initiativeNo);
    const revId = "ai_revision_" + requestId + "_" + no;
    if (revisions.some(rev => rev.id === revId)) throw new Error("同じ操作IDが取り組みの版に既に存在します");
    const { id: _i, number: _n, savedAt: _s, requestId: _q, source: _o, reason: _r, ...content } = previous;
    const why = ("マイルストーン「" + milestoneTitle + "」（" + milestoneId + "）を消したため結びを外す：" + reason).slice(0, 600);
    const revision: Obj = {
      id: revId, number: revisions.length + 1, savedAt: at,
      requestId, source: "approved_mcp_change", reason: why,
      ...content,
      linkedMilestoneIds: linked.filter(id => id !== milestoneId),
    };
    views.push({ kind: "initiative", action: "update", id: str(r.id), title: no + " " + str(previous.name),
      before: display(previous, milestones, kpis), after: display(revision, milestones, kpis) as Obj });
    return { ...r, revisions: [...revisions, revision] };
  });
  if (!views.length) return [];
  doc.records = next;
  doc.updatedAt = at;
  if (bytes(doc) > 700000) throw new Error("取り組みの保存容量が上限に達しました");
  state[INITIATIVES_KEY] = doc;
  return views;
}

/** 読む道具の中身。13 件の現在の版と結び、逆引き（マイルストーン・KPI → 取り組みの番号）を返す */
export function buildInitiativesView(
  rawStore: unknown, milestones: Item[], kpis: Item[], opts: { initiativeNo?: string; includeHistory?: boolean } = {},
  projects: Item[] = [],
) {
  if (rawStore === null) {
    return { ok: true, readonly: true, state: "not_configured", count: 0, initiatives: [],
      note: "取り組みはまだ 1 件も登録されていません（文書 os_initiatives_v1 が無い）" };
  }
  const doc = initiativeStore(rawStore);
  let rows = doc.records as Item[];
  if (opts.initiativeNo !== undefined) {
    if (!NO.test(opts.initiativeNo)) throw new Error("initiative_no は 01〜99 の 2 桁で渡してください");
    rows = rows.filter(r => r.initiativeNo === opts.initiativeNo);
    if (!rows.length) throw new Error("取り組み " + opts.initiativeNo + " は登録されていません");
  }
  const milestoneLinks: Record<string, string[]> = {};
  const kpiLinks: Record<string, string[]> = {};
  for (const r of doc.records as Item[]) {
    const last = (r.revisions as Obj[]).at(-1) as Obj;
    for (const mid of (last.linkedMilestoneIds as string[] | undefined) ?? []) (milestoneLinks[mid] ??= []).push(str(r.initiativeNo));
    for (const kid of (last.linkedKpiIds as string[] | undefined) ?? []) (kpiLinks[kid] ??= []).push(str(r.initiativeNo));
  }
  const content = (rev: Obj) => ({
    name: rev.name, stage: rev.stage, overview: rev.overview,
    ideals: rev.ideals, conditions: rev.conditions, kpis: rev.kpis,
    approaches: rev.approaches, plans: rev.plans, obstacles: rev.obstacles, progress: rev.progress,
  });
  // v1.12.0：組にした TaskMaster のプロジェクト（id と名前。名前は見つからなければ null）
  const project = (rev: Obj) => {
    const pid = str(rev.taskmasterProjectId);
    const p = pid ? projects.find(x => str(x.id) === pid) : undefined;
    return { taskmaster_project_id: pid || null, taskmaster_project_name: p ? (str(p.title) || null) : null };
  };
  const projectLinks: Record<string, string[]> = {};
  for (const r of doc.records as Item[]) {
    const pid = str(((r.revisions as Obj[]).at(-1) as Obj).taskmasterProjectId);
    if (pid) (projectLinks[pid] ??= []).push(str(r.initiativeNo));
  }
  const initiatives = rows.map(r => {
    const revs = r.revisions as Obj[];
    const last = revs.at(-1) as Obj;
    return {
      initiative_no: r.initiativeNo, id: r.id,
      version: last.number, saved_at: last.savedAt, last_reason: last.reason,
      ...content(last),
      ...project(last),
      linked_milestones: ((last.linkedMilestoneIds as string[] | undefined) ?? []).map(mid => {
        const m = milestones.find(x => x.id === mid);
        return m ? { id: mid, title: m.title, status: m.status, dueDate: m.dueDate ?? "" } : { id: mid, missing: true };
      }),
      linked_kpis: ((last.linkedKpiIds as string[] | undefined) ?? []).map(kid => {
        const k = kpis.find(x => x.id === kid);
        return k ? { id: kid, title: k.title, unit: k.unit ?? "", monthlyTarget: k.monthlyTarget ?? null } : { id: kid, missing: true };
      }),
      ...(opts.includeHistory ? {
        history: [...revs].reverse().map(rev => ({
          version: rev.number, saved_at: rev.savedAt, reason: rev.reason, ...content(rev),
          linkedMilestoneIds: rev.linkedMilestoneIds ?? [], linkedKpiIds: rev.linkedKpiIds ?? [],
          taskmasterProjectId: str(rev.taskmasterProjectId) || null,
        })),
      } : {}),
    };
  });
  return {
    ok: true, readonly: true, state: "ready", count: initiatives.length,
    total_versions: (doc.records as Item[]).reduce((n, r) => n + (r.revisions as Obj[]).length, 0),
    initiatives,
    milestone_links: milestoneLinks,
    kpi_links: kpiLinks,
    project_links: projectLinks,
    note: "KPI の今月の実績は haAku__get_kpi_progress で読む。過去の版と理由は include_history: true で返す。",
  };
}

/** 書き込みの記録（get_management_write_audit）に載せる行 */
export function initiativeEvents(raw: unknown): { state: string; items: { request_id: string; kind: string; target_id: string; at: string; title: string; reason: string }[] } {
  if (raw === null || raw === undefined) return { state: "not_configured", items: [] };
  const doc = initiativeStore(raw);
  const items = [];
  for (const r of doc.records as Item[]) {
    for (const rev of r.revisions as Obj[]) {
      if (rev.source === "approved_mcp_change") {
        items.push({ request_id: str(rev.requestId), kind: "initiative", target_id: str(r.id),
          at: str(rev.savedAt), title: str(r.initiativeNo) + " " + str(rev.name), reason: str(rev.reason) });
      }
    }
  }
  return { state: "ready", items };
}
