/**
 * shia2n-mcp / src/utage-archive.ts（v1.68.0・2026-11-06 開発部・UTAGE 解約の便 U1「UTAGE の写し」）
 *
 * UTAGE の中身（ファネル・ページ・シナリオとメッセージ・LINE・読者・イベント・会員サイト・商品・売上）を
 * 全部読み、保管庫（R2 の shia2n-backup）の utage-archive/ に写す。解約しても消えず、あとで AI が参考にできる形で残す。
 * 作る前の 1 枚に Naoki OK（2026-11-06 19:47）・「アーカイブ的に写して、AI で参考にできる形で」（19:56）。
 *
 * 読み方：UTAGE の MCP（https://api.utage-system.com/mcp）の読む道具を tools/call で呼ぶ（cron-consult-manager-intake.ts と同じ）。
 *   REST に無いイベント・会員サイト・商品・売上も、MCP の道具なら読める。UTAGE には何も書かない（list と get だけ）。
 *
 * 進め方：1 回で全部は読めない（道具を千回以上呼ぶ）ので、やることの列（queue）を保管庫に置き、
 *   cron の 15 分ごとに少しずつ進める。毎晩 JST 3 時台に新しい回を始める（その日の回がまだ無ければ）。utage_archive__run で今すぐも始められる。
 *
 * 置き場（utage-archive/）
 *   state.json                    いま進んでいる回（列・数・失敗）
 *   latest.json                   最後に読み終えた回の番号
 *   runs/<回>/raw/<道具>/<引数>.json   UTAGE が返したそのまま（移すときの元）
 *   runs/<回>/text/<種類>/<番号>.txt   ページ・メッセージ・レッスンの文だけを抜いたもの（AI が読む）
 *   runs/<回>/manifest.json        品目の一覧（種類・番号・名前・道筋・住所・文字数）と数・失敗
 *   runs/<回>/ai/<棚>.md           棚ごとの読み物（AI が最初に読む目次）
 *
 * 個人の情報（読者・LINE 友だち・申込者・受講生・売上）は raw にだけ置き、読み物と AI の道具には数しか出さない。
 */

export interface ArchiveEnv {
  BACKUP_BUCKET: R2Bucket;
  UTAGE_MCP_URL?: string;
  UTAGE_MCP_TOKEN?: string;
}

const ROOT = "utage-archive/";
const STATE_KEY = ROOT + "state.json";
const LATEST_KEY = ROOT + "latest.json";
const DEFAULT_URL = "https://api.utage-system.com/mcp";
const PER_PAGE = 100;
/** 1 回の cron で呼ぶ道具の数と時間の上限（Workers の子の要求 1000 本・時間に余裕を持たせる） */
const TICK_CALLS = 180;
const TICK_MS = 120_000;
const LOCK_MS = 5 * 60_000;
const MAX_ERRORS = 300;
const TEXT_MAX = 200_000;
const EXCERPT = 300;

/** 個人の情報を含む種類。読み物と AI の道具には数だけを出す */
export const PERSONAL_KINDS = new Set(["reader", "line_friend", "applicant", "student", "purchase"]);

export interface Task {
  t: string; // UTAGE の道具の名前
  a: Record<string, unknown>; // 引数
  /** 道筋（ファネル名 › ステップ名 など）。読み物の見出しに使う */
  p?: string;
  tries?: number;
}

export interface Item {
  k: string; // 種類 funnel・step・page・account・scenario・message・line_template・richmenu・autoreply・label・action・tracking・event・site・course・lesson・bundle・product・price・media
  id: string;
  name: string;
  path: string;
  url?: string;
  raw: string; // raw の置き場
  text?: string; // 文の置き場
  chars?: number;
  excerpt?: string;
  info?: Record<string, unknown>;
}

export interface State {
  run: string;
  startedAt: string;
  finishedAt?: string;
  lockUntil?: number;
  queue: Task[];
  calls: number;
  items: Item[];
  /** 個人の情報の数（種類 › アカウントなど › 件数） */
  counts: Record<string, Record<string, number>>;
  errors: { t: string; a: Record<string, unknown>; why: string }[];
  rateLimitedAt?: string;
}

/* ------------------------------------------------------------------ */
/* 小物                                                                */
/* ------------------------------------------------------------------ */

async function readJson<T>(b: R2Bucket, key: string): Promise<T | null> {
  const o = await b.get(key);
  if (!o) return null;
  try {
    return JSON.parse(await o.text()) as T;
  } catch {
    return null;
  }
}

export function jstDate(ms = Date.now()): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 引数を置き場の名前にする（並びをそろえ、使えない字を _ に） */
export function argsKey(a: Record<string, unknown>): string {
  const s = Object.keys(a)
    .sort()
    .map((k) => `${k}=${String(a[k])}`)
    .join("&");
  return (s || "all").replace(/[^A-Za-z0-9=&_.-]/g, "_").slice(0, 180);
}

const rawKey = (run: string, task: Task) => `${ROOT}runs/${run}/raw/${task.t}/${argsKey(task.a)}.json`;
const textKey = (run: string, kind: string, id: string) => `${ROOT}runs/${run}/text/${kind}/${id.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const join = (...ps: (string | undefined)[]) => ps.filter(Boolean).join(" › ");

/**
 * ページ・メール・レッスンの中身から、人が読む文だけを抜く。
 * HTML は字だけにし、番号・色・CSS・空の値は捨てる。住所（http）は残す（どこへ飛ぶかが分かるため）
 */
export function extractText(v: unknown): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const skipKey = /^(id|.*_id|uuid|js_.*|.*_js|script|.*_url_param|meta_og_image|.*_src|is_.*|.*_at|color|.*_color|background.*|css|style|.*_style|class|width|height|padding.*|margin.*|font.*|border.*|align|order|type|created_at|updated_at|icon|image_style|animation.*|.*_size)$/i;
  const walk = (x: unknown, key: string, depth: number) => {
    if (depth > 40 || out.length > 20000) return;
    if (typeof x === "string") {
      if (skipKey.test(key)) return;
      let s = x;
      if (/<[a-z!/][^>]*>/i.test(s)) {
        s = s
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, "\n")
          .replace(/<[^>]+>/g, " ");
      }
      s = s
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t　]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
      if (s.length < 2) return;
      if (/^#[0-9a-f]{3,8}$/i.test(s)) return; // 色
      if (/^[A-Za-z0-9_-]{6,40}$/.test(s) && !/\s/.test(s)) return; // 番号
      if (/^[\d.]+(px|%|em|rem)?$/.test(s)) return; // 大きさ
      if (/^[a-z-]+\s*:\s*[^;]+;/.test(s)) return; // CSS
      if (/^(true|false|null)$/i.test(s)) return;
      if (/^[a-z_]{2,14}$/.test(s)) return; // 設定の値（none・inner・shadow など）
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
      return;
    }
    if (Array.isArray(x)) {
      for (const y of x) walk(y, key, depth + 1);
      return;
    }
    if (x && typeof x === "object") for (const [k, y] of Object.entries(x as Record<string, unknown>)) walk(y, k, depth + 1);
  };
  walk(v, "", 0);
  return out.join("\n").slice(0, TEXT_MAX);
}

/* ------------------------------------------------------------------ */
/* UTAGE の MCP を呼ぶ                                                  */
/* ------------------------------------------------------------------ */

export class RateLimited extends Error {}

export type CallFn = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export function utageCaller(env: ArchiveEnv): CallFn {
  return async (tool, args) => {
    const url = env.UTAGE_MCP_URL || DEFAULT_URL;
    const token = env.UTAGE_MCP_TOKEN;
    if (!token) throw new Error("UTAGE_MCP_TOKEN がありません");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    if (res.status === 429) throw new RateLimited("UTAGE の回数の上限（429）");
    if (!res.ok) throw new Error(`UTAGE MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = await res.text();
    const jsonText = raw.trim().startsWith("{")
      ? raw
      : raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .pop() ?? "";
    const rpc = JSON.parse(jsonText) as { error?: { message?: string }; result?: { isError?: boolean; content?: { type: string; text?: string }[] } };
    if (rpc.error) throw new Error(`UTAGE MCP error: ${rpc.error.message ?? "unknown"}`);
    const text = rpc.result?.content?.find((c) => c.type === "text" && c.text)?.text ?? "";
    if (/rate_limit/i.test(text)) throw new RateLimited("UTAGE の回数の上限");
    if (rpc.result?.isError) throw new Error(`UTAGE の道具が断った：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };
}

/* ------------------------------------------------------------------ */
/* 何を読むか（最初の列と、返ってきたものから次に読むもの）              */
/* ------------------------------------------------------------------ */

export function rootTasks(today: string): Task[] {
  const pg = { per_page: PER_PAGE, page: 1 };
  return [
    { t: "funnel_list", a: { ...pg } },
    { t: "message_account_list", a: {} },
    { t: "event_list", a: { ...pg } },
    { t: "event_list", a: { ...pg, is_archived: true } },
    { t: "member_site_list", a: { per_page: 100, page: 1 } },
    { t: "payment_product_list", a: {} },
    { t: "payment_product_list", a: { is_archived: true } },
    { t: "payment_purchase_list", a: { ...pg, date_to: today } },
    { t: "media_video_list", a: { ...pg } },
    { t: "media_audio_list", a: { ...pg } },
    { t: "media_list", a: { ...pg } },
  ];
}

interface Expanded {
  next: Task[];
  items: Omit<Item, "raw">[];
  texts: { kind: string; id: string; text: string }[];
  counts: { kind: string; group: string; n: number }[];
}

/** 次のページ（meta の last_page か total で判断） */
function nextPage(task: Task, res: Record<string, unknown>, got: number): Task | null {
  const page = Number(task.a.page);
  if (!Number.isFinite(page)) return null;
  const meta = (res.meta ?? {}) as Record<string, unknown>;
  const per = Number(task.a.per_page) || PER_PAGE;
  const last = Number(meta.last_page);
  const total = Number(meta.total);
  const more = Number.isFinite(last) && last > 0 ? page < last : Number.isFinite(total) ? page * per < total : got >= per;
  return more && got > 0 ? { ...task, a: { ...task.a, page: page + 1 }, tries: 0 } : null;
}

export function expand(task: Task, res: unknown): Expanded {
  const out: Expanded = { next: [], items: [], texts: [], counts: [] };
  const r = (res && typeof res === "object" ? res : {}) as Record<string, unknown>;
  const data = r.data;
  const rows = arr(data);
  const one = (data && typeof data === "object" && !Array.isArray(data) ? data : r) as Record<string, unknown>;
  const a = task.a as Record<string, string>;
  const np = nextPage(task, r, rows.length);
  if (np) out.next.push(np);
  const pg = { per_page: PER_PAGE, page: 1 };
  const item = (k: string, x: Record<string, unknown>, extra: Partial<Omit<Item, "raw">> = {}) =>
    out.items.push({ k, id: str(x.id) || str(x.project_id), name: str(x.name) || str(x.title) || str(x.subject) || "(名前なし)", path: task.p ?? "", ...extra });

  switch (task.t) {
    case "funnel_list":
      for (const f of rows) {
        item("funnel", f, { info: { memo: f.memo, created_at: f.created_at, updated_at: f.updated_at } });
        const p = str(f.name);
        out.next.push({ t: "funnel_step_list", a: { funnel_id: f.id }, p });
        out.next.push({ t: "funnel_tracking_list", a: { funnel_id: f.id }, p });
        out.next.push({ t: "funnel_stats_get", a: { funnel_id: f.id, date_from: "2020-01-01", date_to: jstDate() }, p });
      }
      break;
    case "funnel_step_list":
      for (const s of rows) {
        item("step", s, { url: str(s.step_url) || undefined });
        out.next.push({ t: "funnel_page_list", a: { funnel_id: a.funnel_id, step_id: s.id }, p: join(task.p, str(s.name)) });
      }
      break;
    case "funnel_page_list":
      for (const pg2 of rows) out.next.push({ t: "funnel_page_get", a: { funnel_id: a.funnel_id, step_id: a.step_id, page_id: pg2.id }, p: join(task.p, str(pg2.title) || str(pg2.name)) });
      break;
    case "funnel_page_get": {
      // 欄の名前が変わっても拾えるように、中身全体から抜く（JS・色・番号などは extractText が捨てる）
      const text = extractText(one);
      out.items.push({ k: "page", id: a.page_id, name: str(one.title) || str(one.page_title) || "(名前なし)", path: task.p ?? "", url: str(one.page_url) || str(one.step_url) || undefined, chars: text.length, excerpt: text.slice(0, EXCERPT), info: { content_type: one.content_type } });
      out.texts.push({ kind: "page", id: a.page_id, text });
      break;
    }
    case "funnel_tracking_list":
      for (const t of rows) item("tracking", t, { url: str(t.url) || undefined, info: { step: t.step_name ?? t.step_id } });
      break;
    case "funnel_stats_get":
      out.items.push({ k: "funnel_stats", id: a.funnel_id, name: "ファネルの数（全期間）", path: task.p ?? "" });
      break;
    case "message_account_list":
      for (const ac of rows) {
        item("account", ac, { info: { type: ac.type } });
        const id = ac.id;
        const p = str(ac.name);
        out.next.push({ t: "message_scenario_list", a: { account_id: id }, p });
        out.next.push({ t: "message_label_list", a: { account_id: id, ...pg }, p });
        out.next.push({ t: "message_action_list", a: { account_id: id, ...pg }, p });
        out.next.push({ t: "message_reader_list_all", a: { account_id: id, ...pg }, p });
        if (ac.type === "line" || ac.type === "mail_line") {
          out.next.push({ t: "message_line_friend_list", a: { account_id: id, ...pg }, p });
          out.next.push({ t: "message_line_template_list", a: { account_id: id, ...pg }, p });
          out.next.push({ t: "message_line_richmenu_list", a: { account_id: id }, p });
          out.next.push({ t: "message_line_autoreply_list", a: { account_id: id, ...pg }, p });
        }
      }
      break;
    case "message_scenario_list":
      for (const s of rows) {
        item("scenario", s, { info: { open_title: s.open_title } });
        const p = join(task.p, str(s.title) || str(s.name));
        out.next.push({ t: "message_list", a: { account_id: a.account_id, scenario_id: s.id, ...pg }, p });
        out.next.push({ t: "message_tracking_list", a: { account_id: a.account_id, scenario_id: s.id }, p });
        out.next.push({ t: "message_reader_item_list", a: { account_id: a.account_id, scenario_id: s.id }, p });
      }
      break;
    case "message_list":
      for (const m of rows) out.next.push({ t: "message_get", a: { account_id: a.account_id, scenario_id: a.scenario_id, message_id: m.id }, p: task.p });
      break;
    case "message_get": {
      const text = extractText(one);
      out.items.push({
        k: "message",
        id: a.message_id,
        name: str(one.subject) || str(one.title) || str(one.name) || "(件名なし)",
        path: task.p ?? "",
        chars: text.length,
        excerpt: text.slice(0, EXCERPT),
        info: { channel: one.channel, type: one.type, status: one.status, timing: one.timing ?? one.send_timing ?? one.elapsed_days ?? null, send_at: one.send_at ?? one.reserved_at ?? null },
      });
      out.texts.push({ kind: "message", id: a.message_id, text });
      break;
    }
    case "message_label_list":
      for (const l of rows) item("label", l);
      break;
    case "message_action_list":
      for (const x of rows) item("action", x);
      break;
    case "message_tracking_list":
      for (const t of rows) item("tracking", t, { url: str(t.url) || undefined });
      break;
    case "message_reader_item_list":
      out.items.push({ k: "reader_fields", id: `${a.scenario_id}`, name: "読者項目の定義", path: task.p ?? "" });
      break;
    case "message_line_template_list":
      for (const t of rows) {
        item("line_template", t);
        out.next.push({ t: "message_line_template_get", a: { account_id: a.account_id, template_id: t.id }, p: join(task.p, str(t.name)) });
      }
      break;
    case "message_line_template_get": {
      const text = extractText(one);
      out.items.push({ k: "line_template_body", id: a.template_id, name: str(one.name) || "(名前なし)", path: task.p ?? "", chars: text.length, excerpt: text.slice(0, EXCERPT) });
      out.texts.push({ kind: "line_template_body", id: a.template_id, text });
      break;
    }
    case "message_line_richmenu_list":
      for (const m of rows) item("richmenu", m, { info: { is_archived: m.is_archived } });
      break;
    case "message_line_autoreply_list":
      for (const m of rows) {
        const text = extractText(m);
        item("autoreply", m, { chars: text.length, excerpt: text.slice(0, EXCERPT) });
        out.texts.push({ kind: "autoreply", id: str(m.id), text });
      }
      break;
    case "message_reader_list_all":
      out.counts.push({ kind: "reader", group: task.p ?? a.account_id, n: rows.length });
      break;
    case "message_line_friend_list":
      out.counts.push({ kind: "line_friend", group: task.p ?? a.account_id, n: rows.length });
      break;
    case "event_list":
      for (const e of rows) {
        item("event", e, { url: str(e.register_url) || undefined, info: { type: e.type, fee_type: e.fee_type, fee: e.fee, is_archived: task.a.is_archived === true } });
        const p = str(e.name);
        out.next.push({ t: "event_get", a: { project_id: e.id }, p });
        out.next.push({ t: "event_schedule_list", a: { project_id: e.id, ...pg }, p });
        out.next.push({ t: "event_applicant_list", a: { project_id: e.id, ...pg }, p });
      }
      break;
    case "event_get": {
      const text = extractText(one);
      out.texts.push({ kind: "event", id: a.project_id, text });
      break;
    }
    case "event_schedule_list":
      out.counts.push({ kind: "schedule", group: task.p ?? a.project_id, n: rows.length });
      break;
    case "event_applicant_list":
      out.counts.push({ kind: "applicant", group: task.p ?? a.project_id, n: rows.length });
      break;
    case "member_site_list":
      for (const s of rows) {
        item("site", s);
        const p = str(s.name);
        out.next.push({ t: "member_course_list", a: { site_id: s.id }, p });
        out.next.push({ t: "member_bundle_list", a: { site_id: s.id }, p });
        out.next.push({ t: "member_student_list", a: { site_id: s.id, ...pg }, p });
      }
      break;
    case "member_course_list":
      for (const c of rows) {
        item("course", c, { info: { is_published: c.is_published ?? c.status } });
        const p = join(task.p, str(c.name));
        out.next.push({ t: "member_course_get", a: { site_id: a.site_id, course_id: c.id }, p });
        out.next.push({ t: "member_lesson_list", a: { site_id: a.site_id, course_id: c.id, type: "all", ...pg }, p });
      }
      break;
    case "member_course_get": {
      const text = extractText(one);
      out.texts.push({ kind: "course", id: a.course_id, text });
      break;
    }
    case "member_lesson_list":
      for (const l of rows) {
        const p = join(task.p, str(l.lesson_group_name) || undefined, str(l.name) || str(l.title));
        if (str(l.type) === "rich_text") item("lesson", l, { path: task.p ?? "", info: { type: "rich_text", note: "リッチテキスト形式は UTAGE の道具で中身を読めない（名前だけ）" } });
        else out.next.push({ t: "member_lesson_get", a: { site_id: a.site_id, course_id: a.course_id, lesson_id: l.id }, p });
      }
      break;
    case "member_lesson_get": {
      const text = extractText(one);
      out.items.push({ k: "lesson", id: a.lesson_id, name: str(one.name) || str(one.title) || "(名前なし)", path: task.p ?? "", chars: text.length, excerpt: text.slice(0, EXCERPT), info: { is_published: one.is_published } });
      out.texts.push({ kind: "lesson", id: a.lesson_id, text });
      break;
    }
    case "member_bundle_list":
      for (const b of rows) item("bundle", b);
      break;
    case "member_student_list":
      out.counts.push({ kind: "student", group: task.p ?? a.site_id, n: rows.length });
      break;
    case "payment_product_list":
      for (const pr of rows) {
        item("product", pr, { info: { is_archived: task.a.is_archived === true } });
        out.next.push({ t: "payment_product_detail_list", a: { product_id: pr.id }, p: str(pr.name) });
      }
      break;
    case "payment_product_detail_list":
      for (const d of rows) item("price", d, { info: { charge_type: d.charge_type, amount: d.amount ?? d.price, payment_type: d.payment_type, provider: d.payment_provider ?? d.provider } });
      break;
    case "payment_purchase_list":
      out.counts.push({ kind: "purchase", group: "売上（商品とイベント）", n: rows.length });
      break;
    case "media_video_list":
    case "media_audio_list":
    case "media_list":
      for (const m of rows) item(task.t === "media_video_list" ? "media_video" : task.t === "media_audio_list" ? "media_audio" : "media", m, { url: str(m.url) || undefined });
      break;
    default:
      break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1 回分を進める                                                       */
/* ------------------------------------------------------------------ */

export function newRun(prev: string | null, now = Date.now()): State {
  const d = jstDate(now);
  const run = prev && prev.startsWith(d) ? `${d}-${(Number(prev.split("-")[3] ?? "1") || 1) + 1}` : d;
  return { run, startedAt: new Date(now).toISOString(), queue: rootTasks(d), calls: 0, items: [], counts: {}, errors: [] };
}

/** その日の回をまだ始めていなくて、JST 3 時台なら始める */
export function shouldStart(state: State | null, latest: string | null, now = Date.now()): boolean {
  if (state && !state.finishedAt) return false;
  const h = new Date(now + 9 * 3600_000).getUTCHours();
  if (h !== 3) return false;
  const today = jstDate(now);
  return !(latest && latest.startsWith(today)) && !(state && state.run.startsWith(today));
}

export async function startRun(env: ArchiveEnv, now = Date.now()): Promise<{ ok: boolean; run?: string; why?: string }> {
  const b = env.BACKUP_BUCKET;
  const state = await readJson<State>(b, STATE_KEY);
  if (state && !state.finishedAt) return { ok: false, run: state.run, why: "前の回がまだ読み終わっていない" };
  const latest = (await readJson<{ run: string }>(b, LATEST_KEY))?.run ?? null;
  const s = newRun(state?.run ?? latest, now);
  await b.put(STATE_KEY, JSON.stringify(s));
  return { ok: true, run: s.run };
}

export interface TickResult {
  run: string | null;
  did: number;
  left: number;
  finished: boolean;
  stopped?: string;
}

export async function tick(env: ArchiveEnv, opts: { call?: CallFn; maxCalls?: number; maxMs?: number; now?: number } = {}): Promise<TickResult> {
  const b = env.BACKUP_BUCKET;
  const now = opts.now ?? Date.now();
  let state = await readJson<State>(b, STATE_KEY);
  const latest = (await readJson<{ run: string }>(b, LATEST_KEY))?.run ?? null;
  if (shouldStart(state, latest, now)) {
    state = newRun(state?.run ?? latest, now);
  }
  if (!state || state.finishedAt) return { run: state?.run ?? null, did: 0, left: 0, finished: !!state?.finishedAt };
  if (state.lockUntil && state.lockUntil > now) return { run: state.run, did: 0, left: state.queue.length, finished: false, stopped: "別の回が動いている" };
  state.lockUntil = now + LOCK_MS;
  await b.put(STATE_KEY, JSON.stringify(state));

  const call = opts.call ?? utageCaller(env);
  const maxCalls = opts.maxCalls ?? TICK_CALLS;
  const maxMs = opts.maxMs ?? TICK_MS;
  const t0 = Date.now();
  let did = 0;
  let stopped: string | undefined;
  while (state.queue.length && did < maxCalls && Date.now() - t0 < maxMs) {
    const task = state.queue[0];
    let res: unknown;
    try {
      res = await call(task.t, task.a);
    } catch (e) {
      if (e instanceof RateLimited) {
        state.rateLimitedAt = new Date().toISOString();
        stopped = "UTAGE の回数の上限に当たったので、次の回で続ける";
        break;
      }
      state.queue.shift();
      task.tries = (task.tries ?? 0) + 1;
      if (task.tries < 2) state.queue.push(task); // 1 回だけ列の最後でやり直す
      else if (state.errors.length < MAX_ERRORS) state.errors.push({ t: task.t, a: task.a, why: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      did++;
      state.calls++;
      continue;
    }
    state.queue.shift();
    did++;
    state.calls++;
    const rk = rawKey(state.run, task);
    await b.put(rk, JSON.stringify({ tool: task.t, args: task.a, path: task.p ?? "", at: new Date().toISOString(), result: res }));
    const ex = expand(task, res);
    // 子は先に読む（ファネルの中身を読み終えてから次のファネルへ・途中で止まっても読めた分がまとまっている）
    state.queue.unshift(...ex.next);
    for (const t of ex.texts) await b.put(textKey(state.run, t.kind, t.id), t.text);
    for (const it of ex.items) {
      const tk = ex.texts.find((x) => x.id === it.id && (x.kind === it.k || (it.k === "event" && x.kind === "event")));
      state.items.push({ ...it, raw: rk, ...(tk ? { text: textKey(state.run, tk.kind, tk.id) } : {}) });
    }
    // イベント・コースの説明文は一覧の品目に結ぶ
    for (const t of ex.texts) {
      if (t.kind !== "event" && t.kind !== "course") continue;
      const it = state.items.find((x) => x.k === t.kind && x.id === t.id);
      if (it) Object.assign(it, { text: textKey(state.run, t.kind, t.id), chars: t.text.length, excerpt: t.text.slice(0, EXCERPT) });
    }
    for (const c of ex.counts) {
      state.counts[c.kind] = state.counts[c.kind] ?? {};
      state.counts[c.kind][c.group] = (state.counts[c.kind][c.group] ?? 0) + c.n;
    }
  }
  let finished = false;
  if (!state.queue.length) {
    state.finishedAt = new Date().toISOString();
    await finalize(b, state);
    await b.put(LATEST_KEY, JSON.stringify({ run: state.run, finishedAt: state.finishedAt }));
    finished = true;
  }
  state.lockUntil = undefined;
  await b.put(STATE_KEY, JSON.stringify(state));
  return { run: state.run, did, left: state.queue.length, finished, ...(stopped ? { stopped } : {}) };
}

/* ------------------------------------------------------------------ */
/* 読み物（AI が最初に読む目次）                                         */
/* ------------------------------------------------------------------ */

export const DOCS: Record<string, string> = {
  overview: "概要（数・失敗・読み方）",
  funnels: "ファネルとページ（LP・申込・決済の文面）",
  scenarios: "配信（アカウント・シナリオ・メールと LINE の文面・登録経路・ラベル・アクション）",
  line: "LINE（テンプレート・リッチメニュー・自動応答）",
  events: "イベントと予約（セミナー・個別相談）",
  member_sites: "会員サイト（コース・レッスン・バンドル）",
  products: "商品と価格",
  media: "メディア（動画・音声・画像の名前と住所）",
  people: "人の数（読者・LINE 友だち・申込者・受講生・売上。数だけ）",
};

function line(it: Item): string {
  const bits = [`- **${it.name}**`, it.url ? `（${it.url}）` : "", it.chars != null ? ` ${it.chars} 字` : "", ` \`${it.k}:${it.id}\``];
  const ex = it.excerpt ? `\n  > ${it.excerpt.replace(/\n+/g, " ／ ").slice(0, EXCERPT)}` : "";
  const info = it.info ? Object.entries(it.info).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}=${String(v)}`).join("・") : "";
  return bits.join("") + (info ? `（${info}）` : "") + ex;
}

function grouped(items: Item[]): string {
  const by = new Map<string, Item[]>();
  for (const it of items) by.set(it.path || "(上の段)", [...(by.get(it.path || "(上の段)") ?? []), it]);
  return [...by]
    .map(([p, xs]) => `### ${p}\n${xs.map(line).join("\n")}`)
    .join("\n\n");
}

export function buildDocs(state: State): Record<string, string> {
  const K = (...ks: string[]) => state.items.filter((x) => ks.includes(x.k));
  const n = (k: string) => state.items.filter((x) => x.k === k).length;
  const head = (t: string) => `# UTAGE の写し：${t}\n\n回 ${state.run}（読み終えた ${state.finishedAt ?? "途中"}）。全文は utage_archive__get に \`種類:番号\` を渡す。\n\n`;
  const counts = (k: string) => Object.entries(state.counts[k] ?? {}).map(([g, v]) => `- ${g}：${v}`).join("\n") || "- 0";
  const docs: Record<string, string> = {};
  docs.overview =
    head("概要") +
    `## 写したものの数\n| 種類 | 数 |\n|---|---|\n` +
    [
      ["ファネル", n("funnel")], ["ステップ", n("step")], ["ページ", n("page")], ["配信アカウント", n("account")], ["シナリオ", n("scenario")], ["メッセージ", n("message")],
      ["LINE テンプレート", n("line_template")], ["リッチメニュー", n("richmenu")], ["自動応答", n("autoreply")], ["ラベル", n("label")], ["アクション", n("action")], ["登録経路", n("tracking")],
      ["イベント", n("event")], ["会員サイト", n("site")], ["コース", n("course")], ["レッスン", n("lesson")], ["バンドル", n("bundle")], ["商品", n("product")], ["価格", n("price")],
      ["メディア（動画・音声・画像）", n("media_video") + n("media_audio") + n("media")],
    ].map(([a, b]) => `| ${a} | ${b} |`).join("\n") +
    `\n\n## 読めなかったもの（${state.errors.length} 件）\n` +
    (state.errors.slice(0, 60).map((e) => `- ${e.t}（${argsKey(e.a)}）：${e.why}`).join("\n") || "- 無し") +
    `\n\n## 読み物\n` + Object.entries(DOCS).map(([k, v]) => `- ${k}：${v}`).join("\n") +
    `\n\n## 決め\n- UTAGE が返したそのままの中身は保管庫の utage-archive/runs/${state.run}/raw/ にある（移すときの元）\n- 個人の情報（読者・友だち・申込者・受講生・売上）は raw にだけ置き、ここには数だけを出す\n- メディアは名前と住所だけ。ファイルそのものは写していない\n`;
  docs.funnels = head("ファネルとページ") + grouped([...K("funnel"), ...K("step"), ...K("page"), ...K("funnel_stats")]);
  docs.scenarios = head("配信") + grouped([...K("account"), ...K("scenario"), ...K("message"), ...K("tracking").filter((x) => x.raw.includes("/message_tracking_list/")), ...K("label"), ...K("action"), ...K("reader_fields")]);
  docs.line = head("LINE") + grouped([...K("line_template"), ...K("line_template_body"), ...K("richmenu"), ...K("autoreply")]);
  docs.events = head("イベントと予約") + grouped(K("event")) + `\n\n## 日程の数\n${counts("schedule")}\n\n## 申込者の数（全日程）\n${counts("applicant")}`;
  docs.member_sites = head("会員サイト") + grouped([...K("site"), ...K("course"), ...K("lesson"), ...K("bundle")]);
  docs.products = head("商品と価格") + grouped([...K("product"), ...K("price")]);
  docs.media = head("メディア") + grouped([...K("media_video"), ...K("media_audio"), ...K("media")]);
  docs.people =
    head("人の数") +
    `## 読者（シナリオごとの登録の行。同じ人が複数のシナリオにいると重なる）\n${counts("reader")}\n\n## LINE 友だち\n${counts("line_friend")}\n\n## イベントの申込者\n${counts("applicant")}\n\n## 会員サイトの受講生\n${counts("student")}\n\n## 売上の行\n${counts("purchase")}\n\n一人ひとりの情報は raw にだけある（移す便で使う）。`;
  return docs;
}

async function finalize(b: R2Bucket, state: State): Promise<void> {
  const docs = buildDocs(state);
  for (const [k, v] of Object.entries(docs)) await b.put(`${ROOT}runs/${state.run}/ai/${k}.md`, v);
  await b.put(
    `${ROOT}runs/${state.run}/manifest.json`,
    JSON.stringify({ run: state.run, startedAt: state.startedAt, finishedAt: state.finishedAt, calls: state.calls, items: state.items, counts: state.counts, errors: state.errors }),
  );
}

/* ------------------------------------------------------------------ */
/* 読む（AI の道具とマーケくんから）                                     */
/* ------------------------------------------------------------------ */

export async function archiveStatus(env: ArchiveEnv): Promise<object> {
  const b = env.BACKUP_BUCKET;
  const state = await readJson<State>(b, STATE_KEY);
  const latest = await readJson<{ run: string; finishedAt: string }>(b, LATEST_KEY);
  const byKind: Record<string, number> = {};
  for (const it of state?.items ?? []) byKind[it.k] = (byKind[it.k] ?? 0) + 1;
  return {
    ok: true,
    latest: latest ?? null,
    current: state
      ? { run: state.run, started_at: state.startedAt, finished_at: state.finishedAt ?? null, calls: state.calls, queue_left: state.queue.length, items: byKind, errors: state.errors.length, rate_limited_at: state.rateLimitedAt ?? null }
      : null,
    docs: DOCS,
  };
}

export async function archiveDoc(env: ArchiveEnv, doc: string, run?: string): Promise<object> {
  const b = env.BACKUP_BUCKET;
  if (!DOCS[doc]) return { ok: false, error: "bad_doc", docs: DOCS };
  const r = run || (await readJson<{ run: string }>(b, LATEST_KEY))?.run;
  if (!r) return { ok: false, error: "no_run", note: "まだ 1 回も読み終えていない。utage_archive__status で進み具合を見る" };
  const o = await b.get(`${ROOT}runs/${r}/ai/${doc}.md`);
  if (!o) return { ok: false, error: "not_found", run: r };
  return { ok: true, run: r, doc, markdown: await o.text() };
}

export async function archiveItem(env: ArchiveEnv, ref: string, opts: { raw?: boolean; run?: string } = {}): Promise<object> {
  const b = env.BACKUP_BUCKET;
  const m = String(ref ?? "").match(/^([a-z_]+):(.+)$/);
  if (!m) return { ok: false, error: "bad_ref", note: "読み物の `種類:番号` をそのまま渡す（例 page:abc123）" };
  const [, kind, id] = m;
  if (PERSONAL_KINDS.has(kind)) return { ok: false, error: "personal", note: "個人の情報は数だけ（people の読み物）" };
  const r = opts.run || (await readJson<{ run: string }>(b, LATEST_KEY))?.run;
  if (!r) return { ok: false, error: "no_run" };
  const man = await readJson<{ items: Item[] }>(b, `${ROOT}runs/${r}/manifest.json`);
  const it = man?.items.find((x) => x.k === kind && x.id === id);
  if (!it) return { ok: false, error: "not_found", run: r };
  const text = it.text ? await (await b.get(it.text))?.text() : undefined;
  let raw: unknown;
  if (opts.raw) {
    const o = await readJson<{ result: unknown }>(b, it.raw);
    raw = o?.result;
    const s = JSON.stringify(raw ?? null);
    if (s.length > 150_000) raw = { note: `大きいので省いた（${s.length} 字）。raw は保管庫の ${it.raw}` };
  }
  return { ok: true, run: r, item: { ...it, text: undefined }, text: text ?? null, ...(opts.raw ? { raw } : {}) };
}

/** 品目を名前・道筋・抜き書きの言葉で探す（多くても 50 件） */
export async function archiveSearch(env: ArchiveEnv, q: { words?: string; kind?: string; limit?: number; run?: string }): Promise<object> {
  const b = env.BACKUP_BUCKET;
  const r = q.run || (await readJson<{ run: string }>(b, LATEST_KEY))?.run;
  if (!r) return { ok: false, error: "no_run" };
  const man = await readJson<{ items: Item[] }>(b, `${ROOT}runs/${r}/manifest.json`);
  const ws = String(q.words ?? "").split(/[\s　]+/).filter(Boolean);
  const hit = (man?.items ?? []).filter((it) => (!q.kind || it.k === q.kind) && ws.every((w) => `${it.name} ${it.path} ${it.excerpt ?? ""} ${it.url ?? ""}`.includes(w)));
  const lim = Math.max(1, Math.min(50, Math.floor(Number(q.limit) || 20)));
  return { ok: true, run: r, matched: hit.length, rows: hit.slice(0, lim).map((it) => ({ ref: `${it.k}:${it.id}`, name: it.name, path: it.path, url: it.url ?? null, chars: it.chars ?? null, excerpt: it.excerpt ?? null })) };
}
