// haAku MCP: one human-approved change set, composed of up to 12 safe edits.
// Neither MCP tool accepts an arbitrary Firestore document path or field name.
// v1.11.0：milestone_delete（承認つきでマイルストーンを消す）を足した
export type ChangeKind = "strategy" | "phase" | "milestone" | "weekly" | "initiative" | "milestone_delete";
export type Change = {
  kind: ChangeKind;
  request_id: string;
  data: Record<string, string>;
  week_start?: string;
};

const FIELDS: Record<ChangeKind, readonly string[]> = {
  strategy: ["recordId", "name", "goal", "approach", "plan", "successCriteria",
    "sourceUrl", "milestoneId", "horizon", "parentRecordId", "reason"],
  phase: ["id", "title", "purpose", "projectId", "startDate", "dueDate"],
  milestone: ["id", "title", "criterion", "dueDate", "status", "area",
    "owner", "projectId", "phaseId", "notionUrl", "dependsOn", "evidence",
    // v1.11.0：前のマスを複数（JSON の文字列で ["id", …]）。dependsOn には 1 つ目が入る
    "dependsOnIds"],
  weekly: ["id", "title", "criterion", "milestoneId", "status",
    "evidence", "note", "changeReason"],
  // v1.9.0：取り組み（13 の取り組み）。一覧の欄と結びの欄は JSON の文字列で受ける（中身は haaku-initiatives.ts で検める）
  initiative: ["initiativeNo", "name", "stage", "overview", "ideals", "conditions", "kpis",
    "approaches", "plans", "obstacles", "progress", "linkedMilestoneIds", "linkedKpiIds", "reason",
    // v1.12.0：組にする TaskMaster のプロジェクトの id（空・null で外す）
    "taskmasterProjectId"],
  // v1.11.0：消すマイルストーンの ID と理由（どちらも必須）
  milestone_delete: ["id", "reason"],
};
const KIND: ChangeKind[] = ["strategy", "phase", "milestone", "weekly", "initiative", "milestone_delete"];
const ID = /^[A-Za-z0-9_-]{10,70}$/;
const REF = /^[A-Za-z0-9_-]{1,180}$/;

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function assertWeekStart(value: string): void {
  if (!validDate(value) || new Date(value + "T00:00:00Z").getUTCDay() !== 1) {
    throw new Error("week_start は月曜日の YYYY-MM-DD で指定してください");
  }
}
export function newTargetId(kind: ChangeKind, requestId: string): string {
  if (kind === "initiative") throw new Error("取り組みのIDは番号から決まります（initiative_番号）");
  if (kind === "milestone_delete") throw new Error("消すマイルストーンは data.id で指定してください");
  return (kind === "strategy" ? "strategy_" : kind === "weekly" ? "weekly_" :
    kind === "milestone" ? "milestone_" : "phase_") + requestId;
}
export function parseChanges(input: string): Change[] {
  if (typeof input !== "string" || new TextEncoder().encode(input).byteLength > 45000) {
    throw new Error("changes_json は45KB以内で指定してください");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch { throw new Error("changes_json がJSONとして読めません。書き込みは行っていません"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12) {
    throw new Error("変更は1回の承認につき1〜12件までです");
  }
  const seen = new Set<string>();
  return parsed.map((raw: unknown, i): Change => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("変更" + (i + 1) + "の形式が不正です");
    }
    const op = raw as Record<string, unknown>;
    if (Object.keys(op).some(k => !["kind", "request_id", "data", "week_start"].includes(k)) ||
        !KIND.includes(op.kind as ChangeKind) || typeof op.request_id !== "string" ||
        !ID.test(op.request_id) || seen.has(op.request_id)) {
      throw new Error("変更" + (i + 1) + "の種類・識別子が不正または重複しています");
    }
    seen.add(op.request_id);
    const kind = op.kind as ChangeKind;
    if (!op.data || typeof op.data !== "object" || Array.isArray(op.data)) {
      throw new Error("変更" + (i + 1) + "のdataはオブジェクトにしてください");
    }
    const data = { ...(op.data as Record<string, unknown>) };
    // v1.12.0：取り組みの taskmasterProjectId だけは null も受ける（空文字と同じ「外す」に直す）
    if (kind === "initiative" && data.taskmasterProjectId === null) data.taskmasterProjectId = "";
    if (Object.keys(data).some(key => !FIELDS[kind].includes(key)) ||
        Object.values(data).some(value => typeof value !== "string")) {
      throw new Error("変更" + (i + 1) + "に許可されていない欄・値の型があります");
    }
    const id = data.id ?? data.recordId;
    if (id && (typeof id !== "string" || !REF.test(id))) {
      throw new Error("変更" + (i + 1) + "の対象IDが不正です");
    }
    if (kind === "weekly") {
      if (typeof op.week_start !== "string") throw new Error("週間コミットに week_start が必要です");
      assertWeekStart(op.week_start);
    } else if (op.week_start !== undefined) {
      throw new Error("week_start は週間コミットにだけ指定できます");
    }
    return {
      kind,
      request_id: op.request_id,
      data: Object.fromEntries(Object.entries(data)) as Record<string, string>,
      ...(kind === "weekly" ? { week_start: op.week_start as string } : {}),
    };
  });
}
export function neededKeys(ops: Change[]): string[] {
  const keys = new Set(["os_roadmap_v1"]);
  for (const op of ops) {
    if (op.kind === "strategy") keys.add("os_strategy_records_v1");
    if (op.kind === "weekly") keys.add("os_weekly_commits_v1_" + op.week_start);
    // 取り組みは結ぶ先（マイルストーン・KPI）を確かめるため、KPI の文書も読む（書かない）
    if (op.kind === "initiative") { keys.add("os_initiatives_v1"); keys.add("os_kpis"); }
    // v1.12.0：プロジェクトを付けるときだけ TaskMaster のプロジェクト一覧も読む（書かない）
    if (op.kind === "initiative" && typeof op.data.taskmasterProjectId === "string" && op.data.taskmasterProjectId.trim()) {
      keys.add("projects");
    }
    // 消すときは、結ばれたタスク・戦略・取り組みを確かめるため読む（書くのはロードマップと取り組みだけ）
    if (op.kind === "milestone_delete") {
      keys.add("os_initiatives_v1"); keys.add("os_kpis");
      keys.add("os_task_links_v1"); keys.add("os_strategy_records_v1");
    }
  }
  return [...keys].sort();
}
export function writeKeys(ops: Change[]): string[] {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.kind === "strategy") keys.add("os_strategy_records_v1");
    if (op.kind === "phase" || op.kind === "milestone") keys.add("os_roadmap_v1");
    if (op.kind === "weekly") keys.add("os_weekly_commits_v1_" + op.week_start);
    if (op.kind === "initiative") keys.add("os_initiatives_v1");
    // 取り組みの文書は結びを外すときだけ変わる。変わらなければ buildManagementChangePlan が書く先から外す
    if (op.kind === "milestone_delete") { keys.add("os_roadmap_v1"); keys.add("os_initiatives_v1"); }
  }
  return [...keys].sort();
}
// Stable JSON for digest and re-read verification, regardless of Firestore map-field ordering.
export function canonical(value: unknown): string {
  if (value === undefined) throw new Error("保存確認値に未定義の欄があります");
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
