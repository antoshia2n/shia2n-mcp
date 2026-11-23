/**
 * shia2n-mcp / src/manager-core.ts / 新設（2026-11-21 v1.125.0 開発部・マネージャーくん 1便目）
 *
 * マネージャーくん（Claude と GPT のチャットの台帳とピン）の計算だけの部品（外に触らない・試験で回す）。
 *   ・チャット 1 本＝mk_chats の 1 行。番号 no（1 から増える）で指す。ai_log__add が会話の最初に作る
 *   ・ピン＝回答 1 つの全文。チャットの中の番号 n（#1 から）。「12 のピン 3」は 12#3 と書く
 *   ・状態は 4 つだけ（進行中・判断待ち・寝かせ中・閉じた）。よくある書き方は言い換えて受ける
 *   ・予約タスクの行は最初から「閉じた」（毎朝の 3 本で一覧が埋まらないため）
 */

type Row = Record<string, any>;

export const STATES = ["進行中", "判断待ち", "寝かせ中", "閉じた"] as const;
export type State = (typeof STATES)[number];

const STATE_ALIASES: ReadonlyArray<[State, string[]]> = [
  ["進行中", ["進行中", "進行", "作業中", "いま", "active", "doing", "open", "inprogress"]],
  ["判断待ち", ["判断待ち", "判断", "待ち", "確認待ち", "承認待ち", "waiting", "decision", "blocked"]],
  ["寝かせ中", ["寝かせ中", "寝かせ", "保留", "休止", "あとで", "parked", "later", "snooze"]],
  ["閉じた", ["閉じた", "閉じる", "完了", "済み", "終わり", "done", "closed", "close"]],
];

/** 状態の書き方を 4 つの値のどれかにする。当てはまらなければ null */
export function normState(s: unknown): State | null {
  const k = String(s ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!k) return null;
  for (const [v, alts] of STATE_ALIASES) if (alts.includes(k)) return v;
  return null;
}

/** 使った場所（ai_log の surface）→ どちらの AI か */
export function aiOf(surface: string): "claude" | "gpt" {
  return surface === "GPT" ? "gpt" : "claude";
}

/** 使った場所 → 最初の状態。予約タスクは人が戻ってこないので閉じた */
export function firstState(surface: string): State {
  return surface === "予約タスク" ? "閉じた" : "進行中";
}

/** チャットの名前（120 字まで・空白をつめる） */
export function chatName(s: unknown): string {
  return String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

/** チャットの住所。http(s) のものだけ受ける。空は null */
export function chatUrl(s: unknown): { ok: true; url: string | null } | { ok: false; message: string } {
  const v = String(s ?? "").trim();
  if (!v) return { ok: true, url: null };
  if (v.length > 500) return { ok: false, message: "チャットの住所は 500 字までです" };
  if (!/^https?:\/\/[^\s]+$/i.test(v)) return { ok: false, message: "チャットの住所は https:// で始まる形で渡してください" };
  return { ok: true, url: v };
}

/**
 * チャットの指し方を読む。
 *   "12"・"#12"・"c12"・"チャット12"・12 → { no: 12 }
 *   "https://…" → { url }
 *   それ以外の言葉 → { words }（名前・役割の一部。例「統括」）
 */
export type ChatRef = { no: number } | { url: string } | { words: string[] } | null;
export function parseChatRef(v: unknown): ChatRef {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? { no: v } : null;
  const s = String(v ?? "").trim().normalize("NFKC");
  if (!s) return null;
  const m = s.match(/^(?:チャット|chat|c)?\s*#?\s*(\d{1,12})$/i);
  if (m) { const no = Number(m[1]); return no > 0 ? { no } : null; }
  if (/^https?:\/\//i.test(s)) return { url: s };
  const words = s.split(/[\s　]+/).map((w) => w.toLowerCase()).filter(Boolean);
  return words.length ? { words } : null;
}

/**
 * ピンの指し方を読む。"12#3"・"12-3"・"12のピン3"・"チャット12 ピン3" → { chat: "12", n: 3 }
 * ピンの番号だけ（"3"・"#3"・"ピン3"）は { chat: null, n: 3 }
 */
export function parsePinRef(v: unknown): { chat: string | null; n: number } | null {
  const s = String(v ?? "").trim().normalize("NFKC");
  if (!s) return null;
  let m = s.match(/^(?:チャット|chat|c)?\s*#?\s*(\d{1,12})\s*(?:#|-|の?ピン|\s+ピン|\s+pin|\/)\s*#?\s*(\d{1,6})$/i);
  if (m) return { chat: m[1], n: Number(m[2]) };
  m = s.match(/^(?:ピン|pin)?\s*#?\s*(\d{1,6})$/i);
  if (m) return { chat: null, n: Number(m[1]) };
  return null;
}

/** ピンの番号（1 以上の整数）。文字の "#3"・"ピン3" も受ける */
export function pinNo(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  const r = parsePinRef(v);
  return r && r.chat === null && r.n > 0 ? r.n : null;
}

export type PinCheck = { ok: true; title: string; body: string } | { ok: false; message: string };
/** ピンの題と全文を確かめる。題は 120 字まで（空白はつめる）、全文は 1〜200,000 字（そのまま残す） */
export function checkPin(title: unknown, body: unknown): PinCheck {
  const t = String(title ?? "").trim().replace(/\s+/g, " ");
  const b = String(body ?? "");
  if (!t) return { ok: false, message: "title（ピンの題）が空です。あとで探すときの言葉で短く" };
  if (t.length > 120) return { ok: false, message: "title は 120 字までです" };
  if (!b.trim()) return { ok: false, message: "body（回答の全文）が空です。要約ではなく、ピンする回答をそのまま全部" };
  if (b.length > 200000) return { ok: false, message: "body は 200,000 字までです。長い回答は分けてピンしてください" };
  return { ok: true, title: t, body: b };
}

export type UpdateCheck =
  | { ok: true; patch: Record<string, string | null> }
  | { ok: false; message: string };
/** 状態・何をしているか・名前・住所の書き直しを確かめる。何も無ければ断る */
export function checkUpdate(input: { state?: unknown; doing?: unknown; name?: unknown; url?: unknown }): UpdateCheck {
  const patch: Record<string, string | null> = {};
  if (input.state !== undefined && input.state !== null && String(input.state).trim() !== "") {
    const st = normState(input.state);
    if (!st) return { ok: false, message: `state は ${STATES.join("・")} のどれかです（受け取った値：${String(input.state)}）` };
    patch.state = st;
  }
  if (input.doing !== undefined && input.doing !== null) {
    const d = String(input.doing).trim().replace(/\s+/g, " ");
    if (d.length > 200) return { ok: false, message: "doing（何をしているかの 1 行）は 200 字までです" };
    patch.doing = d;
  }
  if (input.name !== undefined && input.name !== null && String(input.name).trim() !== "") {
    patch.name = chatName(input.name);
  }
  if (input.url !== undefined && input.url !== null) {
    const u = chatUrl(input.url);
    if (!u.ok) return { ok: false, message: u.message };
    patch.url = u.url;
  }
  if (!Object.keys(patch).length) return { ok: false, message: "書き直すもの（state・doing・name・url のどれか）がありません" };
  return { ok: true, patch };
}

/**
 * 名前の言葉からチャットを選ぶ（ピンの番号があれば、そのピンを持つものだけ）。
 * 全部の言葉を名前・役割・何をしているかのどれかに含むものを、最後に触った順に並べる。
 * 先頭が選ばれたもの、ほかは候補として返す。
 */
export function pickChats(rows: Row[], words: string[], n?: number | null): Row[] {
  const ws = words.map((w) => w.toLowerCase()).filter(Boolean);
  return rows
    .filter((r) => {
      const hay = `${r.name ?? ""} ${r.role ?? ""} ${r.doing ?? ""}`.toLowerCase();
      return ws.every((w) => hay.includes(w));
    })
    .filter((r) => !n || Number(r.pin_count || 0) >= n)
    .sort((a, b) => String(b.touched_at).localeCompare(String(a.touched_at)));
}

const JST_MS = 9 * 60 * 60 * 1000;
/** ISO の時刻 → 日本時間の "YYYY-MM-DD HH:mm" */
export function jstShort(iso: unknown): string {
  const t = new Date(String(iso ?? "")).getTime();
  if (isNaN(t)) return "";
  return new Date(t + JST_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** 台帳の 1 行 → 返す形 */
export function chatOut(r: Row) {
  return {
    番号: Number(r.no),
    名前: String(r.name ?? ""),
    AI: String(r.ai ?? ""),
    状態: String(r.state ?? ""),
    何をしているか: String(r.doing ?? ""),
    住所: r.url ? String(r.url) : null,
    役割: r.role ? String(r.role) : null,
    ピンの数: Number(r.pin_count || 0),
    最後に触った: jstShort(r.touched_at),
    作った: jstShort(r.created_at),
    全文を読んだ: r.transcript_at ? jstShort(r.transcript_at) : null,
    往復: r.turns == null ? null : Number(r.turns),
    取り組み: r.initiative_no ? { 番号: String(r.initiative_no), 名前: String(r.initiative_name ?? "") } : null,
    判断のタスク: r.tm_task_id ? `https://taskmaster.shia2n.jp/?task=${encodeURIComponent(String(r.tm_task_id))}` : null,
    分野: r.area ? String(r.area) : null,
    作業: r.work && r.work.id ? { 番号: Number(r.work.id), 名前: String(r.work.name ?? ""), 状態: String(r.work.state ?? "") } : null,
    番: turnLabel(r),
  };
}

/** ピンの 1 行 → 返す形（全文つきは full=true） */
export function pinOut(p: Row, chat?: Row | null, full = false) {
  return {
    ピン: `${Number(p.chat_no)}#${Number(p.n)}`,
    チャット番号: Number(p.chat_no),
    番号: Number(p.n),
    題: String(p.title ?? ""),
    作った: jstShort(p.created_at),
    リンク: `https://manager.shia2n.jp/#p${Number(p.chat_no)}-${Number(p.n)}`, // v1.139.0：そのピンを開く住所
    ...(chat ? { チャットの名前: String(chat.name ?? ""), チャットの住所: chat.url ? String(chat.url) : null } : {}),
    ...(full ? { 全文: String(p.body ?? ""), 字数: String(p.body ?? "").length } : {}),
  };
}

/* ─── v1.126.0（2026-11-21 2便目）：シアニンパネルが自動で読んだチャットを受ける ─── */

/** チャットの住所なら、どちらの AI か。住所の形が違えば null（Claude Code のセッションは受けない） */
export function chatPageOf(u: unknown): { url: string; service: "claude" | "chatgpt" } | null {
  let x: URL;
  try { x = new URL(String(u ?? "")); } catch { return null; }
  if (x.protocol !== "https:") return null;
  const path = x.pathname.replace(/\/+$/, "");
  if (x.hostname === "claude.ai" && /^\/chat\/[0-9a-f-]{8,}$/i.test(path)) return { url: `https://claude.ai${path}`, service: "claude" };
  // v1.132.1：ChatGPT のプロジェクトのチャットは /g/<プロジェクト>/c/<番号> で、プロジェクトの部分が途中で変わる（-xji-… が付く）。
  // 会話の番号だけで決まるので /c/<番号> の形にそろえる
  const cg = path.match(/^(?:\/g\/[A-Za-z0-9_-]+)?\/c\/([A-Za-z0-9-]{8,})$/);
  if ((x.hostname === "chatgpt.com" || x.hostname === "chat.openai.com") && cg) return { url: `https://chatgpt.com/c/${cg[1]}`, service: "chatgpt" };
  return null;
}

/** 全文の中の「台帳 #12」（全角も）から番号を取る。いちばん最初のものだけ */
export function markerNo(text: unknown): number | null {
  const m = String(text ?? "").normalize("NFKC").match(/台帳\s*#\s*(\d{1,9})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

export type Turn = { user: string; reply: string; k?: string };
/** 往復を 1 枚の文にする（## Naoki ／ ## Claude か ChatGPT） */
export function transcriptOf(turns: Turn[], service: "claude" | "chatgpt"): string {
  const ai = service === "chatgpt" ? "ChatGPT" : "Claude";
  return turns.map((t) => `## Naoki\n${String(t.user ?? "").trim()}\n\n## ${ai}\n${String(t.reply ?? "").trim()}`).join("\n\n").trim();
}

/**
 * 往復を番号（k）で足し合わせる（v1.126.2）。ChatGPT は画面に出ている往復しか描かないので、
 * 前に受けた分（old）に、今回読めた分（cur）を重ねる。同じ番号は今回の中身で置き換え（返事が伸びた分を取る）、
 * 新しい番号は今回の並びで直前にある番号のすぐ後ろへ（無ければ直後にある番号の前・どちらも無ければ末尾）。
 * 今回の分に番号が 1 つも無ければ（Claude はいつも全部を描く）、今回の分で丸ごと置き換える。
 */
export function mergeTurns(old: Turn[] | null | undefined, cur: Turn[]): Turn[] {
  if (!cur.some((t) => t.k) || !old || !old.length) return cur;
  const out: Turn[] = old.filter((t) => t.k).map((t) => ({ ...t }));
  const at = (k: string) => out.findIndex((t) => t.k === k);
  cur.forEach((t, i) => {
    if (!t.k) return;
    const j = at(t.k);
    if (j >= 0) { out[j] = { ...t }; return; }
    let pos = -1;
    for (let p = i - 1; p >= 0 && pos < 0; p--) { const q = cur[p].k ? at(cur[p].k as string) : -1; if (q >= 0) pos = q + 1; }
    if (pos < 0) for (let n = i + 1; n < cur.length && pos < 0; n++) { const q = cur[n].k ? at(cur[n].k as string) : -1; if (q >= 0) pos = q; }
    if (pos < 0) pos = out.length;
    out.splice(pos, 0, { ...t });
  });
  return out;
}

export type CaptureCheck =
  | { ok: true; url: string; service: "claude" | "chatgpt"; title: string; transcript: string; turns: number; list: Turn[]; project: string | null; group: string | null; seen: boolean }
  | { ok: false; message: string };
/** 拡張から来た 1 件を確かめる。題は 120 字まで（無ければ最初の発言から）、全文は 2,000,000 字まで */
export function checkCapture(body: Record<string, unknown>): CaptureCheck {
  const page = chatPageOf(body.url);
  if (!page) return { ok: false, message: "Claude か ChatGPT のチャットの住所ではありません" };
  const raw = Array.isArray(body.turns) ? body.turns : [];
  const turns: Turn[] = raw
    .map((t: any) => ({ user: String(t?.user ?? ""), reply: String(t?.reply ?? ""), ...(t?.k ? { k: String(t.k).slice(0, 100) } : {}) }))
    .filter((t) => t.user.trim() || t.reply.trim());
  if (!turns.length) return { ok: false, message: "往復が 1 つもありません" };
  const transcript = transcriptOf(turns, page.service);
  if (transcript.length > 2000000) return { ok: false, message: "全文が 2,000,000 字を超えています" };
  const fallback = turns[0].user.trim().replace(/\s+/g, " ").slice(0, 60) || "名前のないチャット";
  const title = chatName(String(body.title ?? "").replace(/\s*[-|｜]\s*(ChatGPT|Claude)\s*$/, "")) || fallback;
  return { ok: true, url: page.url, service: page.service, title, transcript, turns: turns.length, list: turns, project: areaName(body.project), group: groupName(body.group), seen: body.seen !== false };
}

/** 鍵の文字列 → sha256（16 進）。鍵そのものは台帳に置かない */
export async function keyHash(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 新しい鍵（mk_ で始まる 43 字の乱数） */
export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "mk_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ─── v1.128.0（2026-11-22 4便目）：分野の棚・やったこと・題名でピン ─── */

/** 分野（棚の名前）。Claude・ChatGPT のプロジェクト名か役割。空白をつめて 60 字まで。空は null */
export function areaName(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  return s || null;
}

/** 分野を拡張が書いてよいか。手（画面）とチャット（道具）で決めたものは上書きしない */
export function extMayWriteArea(row: Record<string, any> | null | undefined, project: string | null): boolean {
  if (!project || !row) return false;
  if (row.area_src === "手" || row.area_src === "チャット") return false;
  return row.area !== project;
}

export type DoneCheck = { ok: true; text: string } | { ok: false; message: string };
/** やったことの 1 行。空白をつめて 1〜200 字 */
export function checkDone(v: unknown): DoneCheck {
  const t = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!t) return { ok: false, message: "text（やったことの 1 行）が空です。「○○をした」の形で" };
  if (t.length > 200) return { ok: false, message: "text は 200 字までです" };
  return { ok: true, text: t };
}

/** ピンを題で探すときの言葉（空白で区切る・PostgREST の区切り字は外す） */
export function titleWords(q: unknown): string[] {
  return String(q ?? "").normalize("NFKC").replace(/[*,()"\\]/g, " ").replace(/の?ピン$/, "").split(/[\s　]+/).map((w) => w.trim()).filter(Boolean).slice(0, 6);
}

/** 題で当たったピンを並べる：題がそのまま一致 → 題が言葉で始まる → 新しい順 */
export function rankPins<T extends { title?: unknown; created_at?: unknown }>(rows: T[], q: string): T[] {
  const k = String(q ?? "").normalize("NFKC").trim().replace(/の?ピン$/, "").toLowerCase();
  const score = (r: T) => { const t = String(r.title ?? "").normalize("NFKC").toLowerCase(); return t === k ? 2 : t.startsWith(k) ? 1 : 0; };
  return [...rows].sort((a, b) => score(b) - score(a) || String(b.created_at).localeCompare(String(a.created_at)));
}

/** 日本時間の今日の 0 時、今週の月曜 0 時（ISO） */
export function jstSince(range: "today" | "week", now = Date.now()): string {
  const j = new Date(now + JST_MS);
  const day0 = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - JST_MS;
  if (range === "today") return new Date(day0).toISOString();
  const dow = (j.getUTCDay() + 6) % 7; // 月曜 0
  return new Date(day0 - dow * 86400000).toISOString();
}

/* ─── v1.129.0（2026-11-22 5便目）：作業（分野 ＞ 作業 ＞ チャット） ─── */

export const WORK_STATES = ["進行中", "済み"] as const;

/** 作業の名前。空白をつめて 80 字まで。空は null */
export function workName(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  return s || null;
}

/** 同じ作業かを比べるための形（全角半角・大文字小文字・空白と記号を無視） */
export function workKey(v: unknown): string {
  return String(v ?? "").normalize("NFKC").toLowerCase().replace(/[\s　・、。,.:：;；!！?？()（）「」『』【】\[\]〈〉<>"'`~〜\-ー_/／|｜]/g, "");
}

/** 作業の状態を言い換えて受ける。当てはまらなければ null */
export function normWorkState(v: unknown): "進行中" | "済み" | "中止" | null {
  const k = String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!k) return null;
  if (["中止", "やめた", "やめる", "アーカイブ", "cancel", "canceled", "cancelled", "archived"].includes(k)) return "中止"; // v1.147.0
  if (["済み", "済", "完了", "終わり", "閉じた", "閉じる", "done", "closed"].includes(k)) return "済み";
  if (["進行中", "進行", "再開", "戻す", "open", "active"].includes(k)) return "進行中";
  return null;
}

/** やったことに添える住所（PR など）。https のものだけ・500 字まで。空は null */
export function linkUrl(v: unknown): { ok: true; url: string | null } | { ok: false; message: string } {
  const s = String(v ?? "").trim();
  if (!s) return { ok: true, url: null };
  if (s.length > 500) return { ok: false, message: "link は 500 字までです" };
  if (!/^https:\/\/[^\s]+$/i.test(s)) return { ok: false, message: "link は https:// で始まる住所です" };
  return { ok: true, url: s };
}

/** 作業の見える状態：済み ＞ 中のチャットに判断待ちがあれば判断待ち ＞ 進行中 */
export function workShownState(w: Row, chats: Row[]): "済み" | "判断待ち" | "進行中" {
  if (w.state === "済み") return "済み";
  return chats.some((c) => c.state === "判断待ち") ? "判断待ち" : "進行中";
}

/** 作業の 1 行 → 返す形 */
export function workOut(w: Row, chats: Row[] = [], reqs: Row[] = []) {
  const last = [w.touched_at, ...chats.map((c) => c.touched_at)].filter(Boolean).sort().pop();
  return {
    番号: Number(w.id),
    名前: String(w.name ?? ""),
    分野: w.area ? String(w.area) : null,
    状態: workShownState(w, chats),
    チャットの数: chats.length,
    判断待ち: chats.filter((c) => c.state === "判断待ち").length,
    段階: w.level === undefined || w.level === null ? 1 : Number(w.level),
    型: w.kind ? String(w.kind) : null,
    フォルダ: w.tm_project_id ? { 番号: String(w.tm_project_id), 名前: String(w.tm_project_name ?? "") } : null,
    タスク: w.tm_task_id ? { 番号: String(w.tm_task_id), 期日: w.tm_deadline ? String(w.tm_deadline) : null, 重要度: w.tm_priority ? String(w.tm_priority) : null, 住所: `https://taskmaster.shia2n.jp/?task=${encodeURIComponent(String(w.tm_task_id))}` } : null,
    最後に触った: jstShort(last),
    進み: workProgress(w, chats, reqs),
    タブの数: Array.isArray(w.tabs) ? w.tabs.length : 0,
    タブ: Array.isArray(w.tabs) ? w.tabs.map((t: any) => String(t.url)) : [],
    保存したタブ: Array.isArray(w.tabs) ? w.tabs.map((t: any) => ({ 住所: String(t.url), 題: String(t.title || "") })) : [],
    最後にやったこと: w.last_done ? { 中身: String(w.last_done.text), 時刻: jstShort(w.last_done.at) } : null,
    今のチャット: nowChats(chats).map((c) => ({ 番号: Number(c.no), 名前: String(c.name ?? ""), 住所: c.url ? String(c.url) : null, AI: String(c.ai ?? ""), 番: turnLabel(c) })),
  };
}

/** やったことの中の住所から PR を拾う（同じものは 1 つ・新しい順のまま） */
export function prLinks(done: Array<{ link?: unknown; at?: unknown; chat_no?: unknown }>): Array<{ 住所: string; 時刻: string; チャット番号: number }> {
  const seen = new Set<string>();
  const out: Array<{ 住所: string; 時刻: string; チャット番号: number }> = [];
  for (const d of done) {
    const u = String(d.link ?? "");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u) || seen.has(u)) continue;
    seen.add(u); out.push({ 住所: u, 時刻: jstShort(d.at), チャット番号: Number(d.chat_no) });
  }
  return out;
}

/** Chrome のタブのまとまりの名前（作業の名前になる）。空白をつめて 80 字まで。空は null（v1.132.0） */
export function groupName(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  return s || null;
}

/* ─── v1.133.0（2026-11-22 7便目）：誰の番・作業の進み具合・タブの保存 ─── */

export type Turn3 = "AI" | "新着" | "Naoki";
/** チャットの「誰の番」。寝かせ中・閉じたは出さない */
export function turnLabel(r: Row): "AI が作業中" | "返事が来た" | "Naoki の番" | null {
  if (r.state === "寝かせ中" || r.state === "閉じた") return null;
  if (r.turn === "AI") return "AI が作業中";
  if (r.turn === "新着") return "返事が来た";
  if (r.turn === "Naoki" || r.state === "判断待ち") return "Naoki の番";
  return null;
}

/** 拡張が読んだあとの番：中身が変わっていなければ前のまま（見たなら 新着 → Naoki）。変わったら 見ていれば Naoki・見ていなければ 新着 */
export function nextTurn(prev: string | null | undefined, changed: boolean, seen: boolean): Turn3 | null {
  if (!changed) return prev === "新着" && seen ? "Naoki" : prev === "AI" ? (seen ? "Naoki" : "新着") : null;
  return seen ? "Naoki" : "新着";
}

/** 作業の進み具合：Naoki の番の数・AI が作業中の数・依頼の済み／全部・まとまりの色 */
export function workProgress(w: Row, chats: Row[], reqs: Row[]) {
  const live = reqs.filter((r) => r.state !== "やめた");
  const naoki = chats.filter((c) => { const t = turnLabel(c); return t === "Naoki の番" || t === "返事が来た"; }).length + reqs.filter((r) => r.state === "OK待ち").length;
  const ai = chats.filter((c) => turnLabel(c) === "AI が作業中").length + reqs.filter((r) => r.state === "実行中" || r.state === "順番待ち").length;
  const color = w.state === "済み" ? "grey" : naoki ? "red" : ai ? "blue" : "green";
  return { Naokiの番: naoki, AIが作業中: ai, 依頼の済み: live.filter((r) => r.state === "済み").length, 依頼の全部: live.length, 評価待ち: reqs.filter(needsScore).length, 色: color as "grey" | "red" | "blue" | "green" };
}

export type TabRow = { url: string; title: string };
/** 保存するタブ：http(s) の住所だけ・同じ住所は 1 つ・40 本まで。題は 200 字まで */
export function checkTabs(v: unknown, max = 40): TabRow[] {
  const seen = new Set<string>();
  const out: TabRow[] = [];
  for (const t of Array.isArray(v) ? v : []) {
    const url = String((t as any)?.url ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000 || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: String((t as any)?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) });
    if (out.length >= max) break;
  }
  return out;
}

/** 「今」のカードに出すチャット：閉じた・寝かせ中を除き、返事が来た → Naoki の番 → AI が作業中 → ほか、同じなら新しい順に 3 本（v1.134.0） */
export function nowChats(chats: Row[]): Row[] {
  const rank = (c: Row) => ({ "返事が来た": 0, "Naoki の番": 1, "AI が作業中": 2 } as Record<string, number>)[turnLabel(c) ?? ""] ?? 3;
  return chats.filter((c) => c.state !== "閉じた" && c.state !== "寝かせ中" && c.name !== undefined)
    .sort((a, b) => rank(a) - rank(b) || String(b.touched_at ?? "").localeCompare(String(a.touched_at ?? ""))).slice(0, 3);
}

/* ─── v1.136.0（2026-11-22 9便目）：作業の型と評価（クオリティ・仕組み） ─── */

/** 作業の型（仕事の種類）。空白をつめて 60 字まで。空は null */
export function kindName(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  return s || null;
}

export type ScoreCheck = { ok: true; quality: number; system: number; q_note: string; s_note: string } | { ok: false; message: string };
/** 評価：クオリティ・仕組み とも 0〜100 の整数。一言は 1000 字まで */
export function checkScore(v: Record<string, unknown>): ScoreCheck {
  const n = (x: unknown) => (x === "" || x === null || x === undefined ? NaN : Number(x));
  const q = n(v.quality), s = n(v.system);
  if (!Number.isInteger(q) || q < 0 || q > 100) return { ok: false, message: "クオリティは 0〜100 の数で付けてください" };
  if (!Number.isInteger(s) || s < 0 || s > 100) return { ok: false, message: "仕組みは 0〜100 の数で付けてください" };
  const t = (x: unknown) => String(x ?? "").trim().slice(0, 1000);
  return { ok: true, quality: q, system: s, q_note: t(v.q_note), s_note: t(v.s_note) };
}

/** 両方 100 点か（自動化へ上げる合図） */
export const isPerfect = (s: { quality: number; system: number }) => Number(s.quality) === 100 && Number(s.system) === 100;

/** 点数の流れ：新しい順の評価から、直近 5 回の平均と、その前の 5 回の平均（無ければ null） */
export function scoreTrend(rows: Array<Record<string, any>>) {
  const avg = (xs: Array<Record<string, any>>, k: "quality" | "system") => xs.length ? Math.round(xs.reduce((a, x) => a + Number(x[k]), 0) / xs.length) : null;
  const now = rows.slice(0, 5), prev = rows.slice(5, 10);
  return { 回数: rows.length, クオリティ: avg(now, "quality"), 仕組み: avg(now, "system"), 前のクオリティ: avg(prev, "quality"), 前の仕組み: avg(prev, "system") };
}

/** 評価待ち：この便より後に済みになった依頼で、まだ評価していないもの */
export const SCORE_FROM = "2026-11-22T05:00:00Z";
export function needsScore(r: Row): boolean {
  return r.state === "済み" && !r.scored && !!r.done_at && String(r.done_at) >= SCORE_FROM;
}

export function scoreOut(s: Row) {
  return { 番号: Number(s.id), 依頼: s.request_id ? Number(s.request_id) : null, 型: s.kind ? String(s.kind) : null, クオリティ: Number(s.quality), 仕組み: Number(s.system), クオリティの一言: String(s.q_note ?? ""), 仕組みの一言: String(s.s_note ?? ""), 時刻: jstShort(s.at) };
}
