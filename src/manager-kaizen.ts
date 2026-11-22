/**
 * マネージャーくん 9便目の 2（2026-11-22 開発部・Naoki「業務を理解し、レシピやワークフローと作り込み…良きタイミングでスキルやレシピのアプデ、業務フローの改善を提案」→ 評価で自動化に OK 13:45・「進めて」14:55）
 * 改善係：週に 1 回（月曜 9 時台）、前の回からの材料を集めて、作業「マネージャーくんの改善係」に見直しの依頼を 1 本出す。
 *   ・材料：Naoki の評価（点数と一言）、止まった依頼、型ごとの回数と平均
 *   ・見直しの依頼はすぐ動く（案を出すだけ・保存しない）。実行係は案を manager__propose で 1 件ずつ出し、それが OK待ち になる
 *   ・Naoki が OK した案だけ、実行係がスキルクリエイターで直して保存する
 *   ・評価も止まった依頼も無い週は出さない（材料が無いため）
 */
import type { Env } from "./index.js";
import { getSetting, setSetting } from "./manager-links.js";
import { findOrCreateWork, updateWork } from "./manager-store.js";
import { submitRequest } from "./manager-run.js";
import { jstShort } from "./manager-core.js";

type Row = Record<string, any>;
export const KAIZEN_WORK = "マネージャーくんの改善係";
const LAST_KEY = "kaizen_last";
async function sb(env: Env, path: string): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 前の回から今までの材料（評価・止まった依頼・型ごとの数） */
export async function kaizenMaterial(env: Env, sinceIso: string): Promise<{ text: string; scores: number; stopped: number }> {
  const since = encodeURIComponent(sinceIso);
  const [scores, stopped, works, allScores]: Row[][] = await Promise.all([
    sb(env, `mk_scores?select=work_id,kind,quality,system,q_note,s_note,at&at=gte.${since}&order=at.asc&limit=300`).then((x) => x || []),
    sb(env, `mk_requests?select=id,work_id,title,result,recipe,done_at&state=eq.${encodeURIComponent("止まった")}&done_at=gte.${since}&limit=100`).then((x) => x || []),
    sb(env, `mk_works?select=id,name,kind,state,level&limit=1000`).then((x) => x || []),
    sb(env, `mk_scores?select=kind,quality,system&order=at.desc&limit=1000`).then((x) => x || []),
  ]);
  const name = new Map(works.map((w) => [Number(w.id), String(w.name)]));
  const L: string[] = [];
  L.push(`## 材料（${jstShort(sinceIso)} から）`);
  if (scores.length) {
    L.push("", "### Naoki の評価（クオリティ／仕組み と一言）");
    for (const s of scores) L.push(`- 作業「${name.get(Number(s.work_id)) ?? s.work_id}」・型「${s.kind ?? "なし"}」：クオリティ ${s.quality}${s.q_note ? `（${s.q_note}）` : ""}／仕組み ${s.system}${s.s_note ? `（${s.s_note}）` : ""}`);
  }
  if (stopped.length) {
    L.push("", "### 止まった依頼");
    for (const r of stopped) L.push(`- 依頼 #${r.id}「${r.title}」（作業「${name.get(Number(r.work_id)) ?? r.work_id}」${r.recipe ? `・レシピ ${r.recipe}` : ""}）：${String(r.result || "").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  // 型ごと：完了した作業の数・評価の平均・段階
  const kinds = new Map<string, { done: number; level: number; q: number[]; s: number[] }>();
  for (const w of works) if (w.kind) { const k = kinds.get(w.kind) || { done: 0, level: 0, q: [], s: [] }; if (w.state === "済み") k.done++; k.level = Math.max(k.level, Number(w.level ?? 1)); kinds.set(w.kind, k); }
  for (const s of allScores) if (s.kind && kinds.has(s.kind)) { const k = kinds.get(s.kind)!; if (k.q.length < 5) { k.q.push(Number(s.quality)); k.s.push(Number(s.system)); } }
  if (kinds.size) {
    L.push("", "### 型ごと（完了した作業の数・直近 5 回の平均・段階）");
    const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : "—");
    for (const [k, v] of kinds) L.push(`- ${k}：完了 ${v.done}・クオリティ ${avg(v.q)}・仕組み ${avg(v.s)}・段階 ${v.level}`);
  }
  return { text: L.join("\n"), scores: scores.length, stopped: stopped.length };
}

const BODY_HEAD = `## やること
材料を読み、次のきっかけに当たるものだけ、直しの案を manager__propose で 1 件ずつ出す（chat はこのチャットの番号）。案が無ければ出さない。
- 同じ型の作業が 3 回以上完了していて、その型のレシピが無い → その流れをレシピにする案（recipes__find で探してから）
- 同じスキルへの同じ種類の一言（クオリティ）が 2 回以上 → そのスキルを直す案（skills__feedback_list も見る）
- 仕組みの一言が同じ型で 2 回以上、または止まった依頼が同じ型で 2 回以上 → レシピか流れを直す案
案 1 件の形：title＝何をどう直すか 1 行／body＝直す先（スキルかレシピの名前）・直す中身・根拠（どの作業・どの一言）／why＝期待する変化／stop＝止める条件。

## してはいけないこと
- skills__save・recipes__save・hypotheses__ を呼ばない（保存は Naoki が案に OK してから、その依頼の中でだけ）
- 会員・決済・お金・しあらぼの権利・統括の台帳・外への送信に触らない
`;

/** 改善係を動かす。force でなければ、月曜 9 時台（日本時間）に週 1 回だけ。材料が無ければ出さない */
export async function runKaizen(env: Env, opt: { force?: boolean; now?: Date } = {}): Promise<{ ran: boolean; reason: string; request?: number }> {
  const now = opt.now ?? new Date();
  const jst = new Date(now.getTime() + 9 * 3600e3);
  const week = `${jst.getUTCFullYear()}-${Math.floor((Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - Date.UTC(jst.getUTCFullYear(), 0, 1)) / 6048e5)}`;
  const last = await getSetting(env, LAST_KEY);
  if (!opt.force) {
    if (jst.getUTCDay() !== 1 || jst.getUTCHours() !== 9) return { ran: false, reason: "月曜 9 時台だけ" };
    if (last && last.startsWith(week + "|")) return { ran: false, reason: "今週はもう動いた" };
  }
  const since = last ? last.split("|")[1] : new Date(now.getTime() - 7 * 864e5).toISOString();
  const m = await kaizenMaterial(env, since);
  await setSetting(env, LAST_KEY, `${week}|${now.toISOString()}`);
  if (!m.scores && !m.stopped) return { ran: false, reason: "材料（評価・止まった依頼）が無い" };
  const { work } = await findOrCreateWork(env, KAIZEN_WORK, null);
  if (Number(work.level ?? 1) !== 1) await updateWork(env, Number(work.id), { level: 1 }); // 案は OK待ち にするため段階 1
  const r = await submitRequest(env, Number(work.id), {
    title: `週の見直し：評価 ${m.scores} 件・止まった依頼 ${m.stopped} 件から直しの案を出す`,
    body: `${BODY_HEAD}\n${m.text}`,
    why: "使うほどスキル・レシピ・流れが良くなり、両方 100 点の型が増えて自動で回る仕事が増えるため",
    stop: "案を出すことだけをする。保存や外への送信が要りそうなら、そこで止めて報告する",
  }, { source: "改善係" });
  return { ran: true, reason: "出した", request: Number(r.req.id) };
}
