/**
 * マネージャーくん 9便目（2026-11-22 開発部・Naoki「僕が作業評価すればいいかな。クオリティと仕組みの観点で。両方100点になったら自動化」→ OK 13:45）
 *   ・作業に「型」（仕事の種類）を付ける。型ごとに任せる段階を覚える（mk_kinds）
 *   ・Naoki が作業か依頼を評価する（クオリティ・仕組み 0〜100 と一言）。一言は改善係（次の便）が読む材料
 *   ・両方 100 点になったら、その型を段階 2（自動で実行）に上げ、開いている同じ型の作業も 2 にする。型の無い作業はその作業だけ上げる
 *   ・型の段階が 2 なら、あとからその型を付けた作業も最初から 2
 */
import type { Env } from "./index.js";
import { ManagerError, updateWork, workById } from "./manager-store.js";
import { SCORE_FROM, isPerfect, kindName, workKey, type ScoreCheck } from "./manager-core.js";

type Row = Record<string, any>;
const enc = encodeURIComponent;
async function sb(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      ...(/^eyJ/.test(String(env.SUPABASE_SERVICE_ROLE_KEY || "")) ? { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : {}),
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new ManagerError("supabase_error", `Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 今ある型の一覧（名前の形が同じものは 1 つ）。新しい型を付けるときは、同じ形のものがあればそちらの名前にそろえる */
export async function kinds(env: Env): Promise<Row[]> {
  return (await sb(env, `mk_kinds?select=name,level,raised_at&order=name.asc&limit=500`)) || [];
}
async function kindRow(env: Env, name: string): Promise<Row | null> {
  const k = workKey(name);
  return (await kinds(env)).find((x) => workKey(x.name) === k) ?? null;
}

/** 作業に型を付ける（空で外す）。型の段階が 2 なら作業も 2 にする */
export async function setKind(env: Env, workId: number, v: unknown): Promise<Row> {
  const name = kindName(v);
  if (!name) return updateWork(env, workId, { kind: null });
  let k = await kindRow(env, name);
  if (!k) k = ((await sb(env, `mk_kinds?select=name,level,raised_at`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ name }) })) || [])[0] ?? null;
  if (!k) throw new ManagerError("not_written", "型の行が返ってきませんでした");
  const w = await workById(env, workId);
  if (!w) throw new ManagerError("work_not_found", `作業 ${workId} はありません`);
  const patch: Record<string, unknown> = { kind: k.name };
  if (Number(k.level) >= 2 && Number(w.level ?? 1) < 2) patch.level = 2;
  return updateWork(env, workId, patch);
}

/** 評価を残す。依頼の評価は付け直せる（同じ依頼は 1 つ）。両方 100 点なら自動化へ上げる */
export async function addScore(env: Env, workId: number, requestId: number | null, sc: Extract<ScoreCheck, { ok: true }>): Promise<{ score: Row; raised: null | { 型: string | null; 作業の数: number } }> {
  const w = await workById(env, workId);
  if (!w) throw new ManagerError("work_not_found", `作業 ${workId} はありません`);
  if (requestId) {
    const r = ((await sb(env, `mk_requests?select=id,work_id,state&id=eq.${requestId}`)) || [])[0];
    if (!r || Number(r.work_id) !== workId) throw new ManagerError("request_not_found", `この作業に依頼 ${requestId} はありません`);
  }
  const row = { work_id: workId, request_id: requestId, kind: w.kind ?? null, quality: sc.quality, system: sc.system, q_note: sc.q_note, s_note: sc.s_note, at: new Date().toISOString() };
  let score: Row | null = null;
  if (requestId) {
    const old = ((await sb(env, `mk_scores?select=id&request_id=eq.${requestId}`)) || [])[0];
    if (old) score = ((await sb(env, `mk_scores?id=eq.${old.id}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) })) || [])[0];
  }
  if (!score) score = ((await sb(env, `mk_scores?select=*`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) })) || [])[0];
  if (!score) throw new ManagerError("not_written", "評価の行が返ってきませんでした");
  if (!isPerfect(sc)) return { score, raised: null };
  // 両方 100 点：型があれば型ごと、無ければこの作業だけ段階 2 へ
  if (!w.kind) {
    if (Number(w.level ?? 1) < 2) await updateWork(env, workId, { level: 2 });
    return { score, raised: { 型: null, 作業の数: 1 } };
  }
  await sb(env, `mk_kinds?name=eq.${enc(w.kind)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ level: 2, raised_at: new Date().toISOString() }) });
  const ups: Row[] = (await sb(env, `mk_works?kind=eq.${enc(w.kind)}&state=eq.${enc("進行中")}&level=lt.2&select=id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ level: 2, touched_at: new Date().toISOString() }) })) || [];
  return { score, raised: { 型: String(w.kind), 作業の数: ups.length } };
}

/** 型の段階を戻す（画面から）。開いている同じ型の作業も同じ段階にする */
export async function setKindLevel(env: Env, name: string, level: number): Promise<number> {
  if (![0, 1, 2].includes(level)) throw new ManagerError("invalid_level", "段階は 0・1・2 です");
  await sb(env, `mk_kinds?name=eq.${enc(name)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ level, raised_at: level === 2 ? new Date().toISOString() : null }) });
  const ups: Row[] = (await sb(env, `mk_works?kind=eq.${enc(name)}&state=eq.${enc("進行中")}&select=id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ level }) })) || [];
  return ups.length;
}

/** 作業の評価と、同じ型の評価（新しい順・流れを見るため 10 件） */
export async function scoresFor(env: Env, work: Row): Promise<{ mine: Row[]; kind: Row[]; kindRow: Row | null }> {
  const [mine, kind, kr] = await Promise.all([
    sb(env, `mk_scores?select=*&work_id=eq.${work.id}&order=at.desc&limit=50`),
    work.kind ? sb(env, `mk_scores?select=*&kind=eq.${enc(work.kind)}&order=at.desc&limit=10`) : Promise.resolve([]),
    work.kind ? kindRow(env, String(work.kind)) : Promise.resolve(null),
  ]);
  return { mine: mine || [], kind: kind || [], kindRow: kr };
}

/** 依頼の番号 → 評価したか（作業の一覧と画面の印） */
export async function scoredRequests(env: Env, workIds: number[]): Promise<Set<number>> {
  if (!workIds.length) return new Set();
  const rows: Row[] = (await sb(env, `mk_scores?select=request_id&work_id=in.(${workIds.join(",")})&request_id=not.is.null&limit=5000`)) || [];
  return new Set(rows.map((r) => Number(r.request_id)));
}

/**
 * 評価待ちの一覧（v1.143.0・統括「朝に 1 回で、まだ評価していない作業を型つきで取りたい」2026-11-22）
 *   ・依頼：SCORE_FROM より後に済みになり、その依頼への評価が無いもの
 *   ・作業：SCORE_FROM より後に完了になり、型が付いていて、その作業への評価が 1 つも無いもの（依頼を通さず終えた作業）。
 *     型の無い完了は外す（試しの作業や、まとめて閉じた重なりが評価待ちに並ばないように。評価は型ごとにたまって自動化に効くため）
 *   作業ごとにまとめ、古く待たせているものが上。
 */
export async function pendingScores(env: Env): Promise<Array<{ work: Row; reqs: Row[]; whole: boolean; since: string }>> {
  const from = enc(SCORE_FROM);
  const [reqs, done]: [Row[], Row[]] = await Promise.all([
    sb(env, `mk_requests?select=id,work_id,title,done_at&state=eq.${enc("済み")}&done_at=gte.${from}&order=done_at.asc&limit=500`).then((x) => x || []),
    sb(env, `mk_works?select=id&state=eq.${enc("済み")}&touched_at=gte.${from}&kind=not.is.null&limit=500`).then((x) => x || []),
  ]);
  const ids = [...new Set([...reqs.map((r) => Number(r.work_id)), ...done.map((w) => Number(w.id))])];
  if (!ids.length) return [];
  const [scores, works]: [Row[], Row[]] = await Promise.all([
    sb(env, `mk_scores?select=work_id,request_id&work_id=in.(${ids.join(",")})&limit=5000`).then((x) => x || []),
    sb(env, `mk_works?select=id,name,kind,state,tm_project_name,touched_at&id=in.(${ids.join(",")})`).then((x) => x || []),
  ]);
  const scoredReq = new Set(scores.filter((s) => s.request_id).map((s) => Number(s.request_id)));
  const scoredWork = new Set(scores.map((s) => Number(s.work_id)));
  const doneIds = new Set(done.map((w) => Number(w.id)));
  const out: Array<{ work: Row; reqs: Row[]; whole: boolean; since: string }> = [];
  for (const w of works) {
    const id = Number(w.id);
    const rs = reqs.filter((r) => Number(r.work_id) === id && !scoredReq.has(Number(r.id)));
    const whole = doneIds.has(id) && !scoredWork.has(id);
    if (!rs.length && !whole) continue;
    const since = [...rs.map((r) => String(r.done_at)), ...(whole ? [String(w.touched_at)] : [])].sort()[0];
    out.push({ work: w, reqs: rs, whole, since });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}
