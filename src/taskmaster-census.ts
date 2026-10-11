/**
 * shia2n-mcp / src/taskmaster-census.ts / 新設（2026-10-11 v1.9.1 開発部）
 *
 * TaskMaster のタスクを、完了したものも含めて全部読み、数だけを返す（題名は返さない）。
 * 依頼：https://www.notion.so/3f69c6c1c43981b8bb09fa162e38da9b の手順 1
 *   「完了したタスクが残っているか（完了の印と終わった日）」を実物で確かめるため。
 *   残っていなければ「行動の率」（結んだタスクの完了 ÷ 全部）が出せないので、作る前に止まる。
 * 読み方は控え（cron-backup.ts）と同じ：置き場が 1 本ずつ（tm_tasks）ならそちらを全部、前の形なら app_data/tasks。
 * あとで haAku のホームの計算も、この readAllTasks を使う。
 */
import { fromVal, readLayout, type FSDoc, type FVal } from "./taskmaster.js";

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/gen-lang-client-0371348401" +
  "/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a/documents";

type Item = Record<string, unknown>;

function docToItem(d: FSDoc): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(d.fields ?? {})) out[k] = fromVal(v as FVal);
  if (!out.id) out.id = d.name.split("/").pop();
  return out;
}

/** 完了したものも含めて全部読む。読めなければ止める（0 件と取り違えない） */
export async function readAllTasks(token: string, uid: string): Promise<{ layout: string; items: Item[]; truncated: boolean }> {
  const layout = await readLayout(token, uid);
  if (layout === "migrating") throw new Error("TaskMaster の置き場を移している途中です。少しおいてもう一度呼んでください");
  const headers = { Authorization: `Bearer ${token}` };
  if (layout === "v2") {
    const items: Item[] = [];
    let pageToken = "";
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${FIRESTORE_BASE}/users/${uid}/tm_tasks?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers });
      if (!r.ok) throw new Error(`tm_tasks の取得に失敗しました（${r.status}）`);
      const j = (await r.json()) as { documents?: FSDoc[]; nextPageToken?: string };
      items.push(...(j.documents ?? []).map(docToItem));
      if (!j.nextPageToken) return { layout, items, truncated: false };
      pageToken = j.nextPageToken;
    }
    return { layout, items, truncated: true };
  }
  const r = await fetch(`${FIRESTORE_BASE}/users/${uid}/app_data/tasks`, { headers });
  if (!r.ok) throw new Error(`app_data/tasks の取得に失敗しました（${r.status}）`);
  const d = (await r.json()) as FSDoc;
  const v = d.fields?.value ? fromVal(d.fields.value as FVal) : null;
  if (!Array.isArray(v)) throw new Error("app_data/tasks の value が一覧の形ではありません");
  return { layout, items: v as Item[], truncated: false };
}

const isTrue = (v: unknown) => v === true || v === "true";

/** 数だけにまとめる。題名・メモは返さない */
export function summarizeTasks(items: Item[]) {
  const done = items.filter(t => isTrue(t.completed));
  const doneAt = done.map(t => (typeof t.doneAt === "string" ? t.doneAt.trim() : "")).filter(Boolean).sort();
  const byMonth: Record<string, number> = {};
  for (const d of doneAt) byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] ?? 0) + 1;
  const statuses: Record<string, number> = {};
  for (const t of items) { const s = typeof t.status === "string" ? t.status : "(無し)"; statuses[s] = (statuses[s] ?? 0) + 1; }
  const fieldsOnDone: Record<string, number> = {};
  for (const t of done) for (const k of Object.keys(t)) fieldsOnDone[k] = (fieldsOnDone[k] ?? 0) + 1;
  return {
    total: items.length,
    completed_true: done.length,
    completed_false: items.filter(t => !isTrue(t.completed)).length,
    archived_true: items.filter(t => isTrue(t.archived)).length,
    open_not_archived: items.filter(t => !isTrue(t.completed) && !isTrue(t.archived)).length,
    completed_with_doneAt: doneAt.length,
    completed_without_doneAt: done.length - doneAt.length,
    doneAt_first: doneAt[0] ?? null,
    doneAt_last: doneAt.at(-1) ?? null,
    doneAt_shapes: [...new Set(doneAt.map(d => d.replace(/\d/g, "9")))],
    completed_by_month: byMonth,
    status_values: statuses,
    fields_on_completed: fieldsOnDone,
  };
}
