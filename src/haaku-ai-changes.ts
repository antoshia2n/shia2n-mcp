// haAku MCP: one human-approved change set, composed of up to 12 safe edits.
// Neither MCP tool accepts an arbitrary Firestore document path or field name.
export type ChangeKind = "strategy" | "phase" | "milestone" | "weekly";
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
    "owner", "projectId", "phaseId", "notionUrl", "dependsOn", "evidence"],
  weekly: ["id", "title", "criterion", "milestoneId", "status",
    "evidence", "note", "changeReason"],
};
const KIND: ChangeKind[] = ["strategy", "phase", "milestone", "weekly"];
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
    const data = op.data as Record<string, unknown>;
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
  }
  return [...keys].sort();
}
export function writeKeys(ops: Change[]): string[] {
  const keys = new Set<string>();
  for (const op of ops) {
    if (op.kind === "strategy") keys.add("os_strategy_records_v1");
    if (op.kind === "phase" || op.kind === "milestone") keys.add("os_roadmap_v1");
    if (op.kind === "weekly") keys.add("os_weekly_commits_v1_" + op.week_start);
  }
  return [...keys].sort();
}
// Stable JSON for digest and re-read verification, regardless of Firestore map-field ordering.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])
    ).join(",") + "}";
  }
  return JSON.stringify(value);
}
