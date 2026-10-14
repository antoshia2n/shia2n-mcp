/**
 * shia2n-mcp / src/taskmaster-by-id.ts / 新設（2026-10-14 v1.17.0 開発部）
 *
 * TaskMaster のタスクを id で読む（documents:batchGet・100 件ずつ）。全部は読まない。
 * もとは haaku-deadline-sync.ts の中にあった（v1.13.0）。結ぶ処理（haaku-home-store.ts の linkTasks）も
 * 「そのタスクがあるか」をこの口で確かめるようにしたので、2 つが同じ口を使えるように外へ出した。
 *   それまでの linkTasks は、1 件を結ぶたびにタスクを全部（2026-10-14 実測 1,801 件）読んでいた。
 *   TaskMaster の画面から結ぶようになると 1 回の選択で 1,801 回の読みになり、無料枠（1 日 5 万回の読み）を圧迫するため
 *   （2026-10-02 に Firestore の無料枠を使い切った件あり）。
 * 依頼：https://www.notion.so/3f99c6c1c43981a3898fdd4d436535fa
 */
import { fromVal, type FSDoc, type FVal } from "./taskmaster.js";

const DB = "projects/gen-lang-client-0371348401/databases/ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const API = "https://firestore.googleapis.com/v1/" + DB + "/documents";

type Ctx = { token: string; uid: string };
export type TaskNow = { exists: boolean; deadline: unknown; hasDeadline: boolean; startDate?: unknown; hasStartDate?: boolean;
  completed: boolean; archived: boolean; updateTime: string };

/** 結んだタスクだけを id で読む（全部は読まない） */
export async function readTasksById(ctx: Ctx, ids: string[]): Promise<Map<string, TaskNow>> {
  const out = new Map<string, TaskNow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await fetch(API + ":batchGet", {
      method: "POST",
      headers: { Authorization: "Bearer " + ctx.token, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: chunk.map(id => DB + "/documents/users/" + ctx.uid + "/tm_tasks/" + encodeURIComponent(id)) }),
    });
    if (!res.ok) throw new Error("TaskMaster のタスクを読めませんでした（" + res.status + "）。書いていません");
    const rows = (await res.json()) as { found?: FSDoc & { updateTime?: string }; missing?: string }[];
    for (const r of rows) {
      if (r.found) {
        const id = decodeURIComponent(r.found.name.split("/").pop() || "");
        const f = r.found.fields ?? {};
        const v = (k: string) => (k in f ? fromVal(f[k] as FVal) : undefined);
        out.set(id, { exists: true, deadline: v("deadline"), hasDeadline: "deadline" in f,
          startDate: v("startDate"), hasStartDate: "startDate" in f,
          completed: v("completed") === true, archived: v("archived") === true, updateTime: r.found.updateTime ?? "" });
      } else if (r.missing) {
        out.set(decodeURIComponent(r.missing.split("/").pop() || ""), { exists: false, deadline: undefined, hasDeadline: false, hasStartDate: false, completed: false, archived: false, updateTime: "" });
      }
    }
  }
  return out;
}

