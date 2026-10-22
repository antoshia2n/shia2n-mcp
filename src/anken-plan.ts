/**
 * 案件くんの「予定」と「リンクの名称」（2026-10-22 開発部・案件のタブの直し）。
 *
 *   ・予定（ak_cases.periods）：クライアント側の期間・日（オファー・公開・イベント・不在）。ガントの一番上の段に出る。
 *     AI が拾ったもの（by: "ai"）は「AI にかけ直す」たびに出し直す。Naoki が画面で足した・直したもの（by: "naoki"）と、
 *     画面で消した AI の予定（hidden: true）は残し、AI は同じものを出し直さない。
 *   ・リンクの名称（ak_cases.link_names）：{ リンクの鍵: { name, by } }。鍵は anken の src/core/links.js の keyOf と同じ。
 *   ・リンクを拾う部分は anken の src/core/links.js の写し（直すときは両方を直す）。
 */

type Row = Record<string, any>;

export const PERIOD_KINDS = ["offer", "release", "event", "off", "other"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export interface Period {
  id: string; title: string; start: string; end: string; kind: PeriodKind;
  project?: string | null; src?: Row | null; by: "ai" | "naoki" | "chat"; hidden?: boolean;
}

async function sha1(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
/** 予定の見分け（題名と始まりの日）。画面の engine.js も同じ形で作る */
export const periodId = (title: string, start: string) => sha1(`${String(title).trim()}|${start}`);

/** AI が出し直した予定を、今ある予定に重ねる。Naoki のもの・消したものは残し、同じものは出し直さない */
export async function mergePeriods(old: Period[], incoming: Omit<Period, "id" | "by">[]): Promise<{ periods: Period[]; added: number; skipped: number }> {
  // AI の予定だけ出し直す。Naoki と案件チャット（anken__add_period・2026-10-22）が入れたもの、消したものは残す
  const keep = (Array.isArray(old) ? old : []).filter((p) => p && (p.by !== "ai" || p.hidden));
  const taken = new Set(keep.map((p) => p.id));
  const out: Period[] = [...keep];
  let added = 0, skipped = 0;
  for (const p of incoming) {
    const end = p.end && p.end >= p.start ? p.end : p.start;
    const id = await periodId(p.title, p.start);
    if (taken.has(id)) { skipped++; continue; }
    taken.add(id);
    out.push({ id, title: p.title, start: p.start, end, kind: p.kind, project: p.project ?? null, src: p.src ?? null, by: "ai" });
    added++;
  }
  out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return { periods: out, added, skipped };
}

/* ───────── リンク（anken src/core/links.js の写し） ───────── */
const URL_RE = /https?:\/\/[^\s<>"'）)」』】、。]+/g;
export const LINK_TYPES: [string, string, RegExp][] = [
  ["doc", "ドキュメント", /docs\.google\.com\/document\//],
  ["sheet", "シート", /docs\.google\.com\/spreadsheets\//],
  ["slide", "スライド", /docs\.google\.com\/presentation\//],
  ["form", "フォーム", /docs\.google\.com\/forms\/|forms\.gle\//],
  ["drive", "ドライブ", /drive\.google\.com\//],
  ["gpt", "ChatGPT", /chatgpt\.com\/|chat\.openai\.com\//],
  ["utage", "UTAGE", /utage-system\.com\//],
  ["youtube", "YouTube", /youtube\.com\/|youtu\.be\//],
  ["x", "X", /(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\//],
  ["whimsical", "Whimsical", /whimsical\.com\//],
  ["zoom", "Zoom", /zoom\.us\//],
];
export const typeOf = (url: string) => (LINK_TYPES.find(([, , re]) => re.test(url)) || ["other", "ほか"])[0] as string;
export const typeLabel = (t: string) => (LINK_TYPES.find(([k]) => k === t) || [t, "ほか"])[1] as string;

/** 同じものを見分ける鍵（Google のファイルは id、ほかは # と末尾の / を落とした URL） */
export function keyOf(url: string): string {
  const g = /docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]+)/.exec(url)
    || /drive\.google\.com\/(?:file\/d|drive\/folders)\/([A-Za-z0-9_-]+)/.exec(url);
  if (g) return `g:${g[2] || g[1]}`;
  return url.replace(/#.*$/, "").replace(/\/$/, "");
}
/** Google のファイルの id（名称を Drive から取りに行くとき用）。Google のファイルでなければ null */
export const googleIdOf = (key: string) => (key.startsWith("g:") ? key.slice(2) : null);

const clean = (s: string) => String(s || "").replace(/^[\s・\-*●■▪◆▼▶︎→①-⑳\d.)）]+/, "").replace(/[\s:：↓⇩👇]+$/, "").trim();

function nameFor(url: string, lineIdx: number, lines: string[]): string {
  const ln = lines[lineIdx] || "";
  const before = clean(ln.slice(0, ln.indexOf(url)));
  if (before && before.length <= 60) return before;
  for (let k = lineIdx - 1; k >= Math.max(0, lineIdx - 2); k--) {
    const t = clean(lines[k]);
    if (t && !/https?:\/\//.test(t) && t.length <= 60) return t;
  }
  const first = clean(lines.find((l) => l.trim() && !/https?:\/\//.test(l)) || "");
  if (first && first.length <= 40) return first;
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.slice(0, 30) : "");
  } catch { return url.slice(0, 40); }
}

export interface LinkRow { key: string; url: string; type: string; name: string; day: string; time: string; who: string; chat: string; count: number; firstDay: string; }

/** 2 つの仮の名前のうち良いほう：住所の形（docs.google.com/… など）でないほう、どちらも同じなら長いほう */
const isHostName = (s: string) => /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s);
const betterName = (a: string, b: string) => (isHostName(a) !== isHostName(b) ? (isHostName(a) ? b : a) : a.length >= b.length ? a : b);

export function extractLinks(msgs: Row[], { chatOf = (_m: Row) => "" } = {}): LinkRow[] {
  const byKey = new Map<string, LinkRow>();
  for (const m of msgs) {
    const lines = String(m.body || "").split("\n");
    lines.forEach((ln, i) => {
      for (const hit of ln.matchAll(URL_RE)) {
        const url = hit[0].replace(/[.,!?！？]+$/, "");
        const key = keyOf(url);
        const ex = byKey.get(key);
        const row = { key, url, type: typeOf(url), name: nameFor(url, i, lines), day: m.day, time: m.at_time || "", who: m.who || "", chat: chatOf(m) };
        if (!ex) byKey.set(key, { ...row, count: 1, firstDay: m.day });
        else {
          ex.count++;
          if (`${m.day} ${m.at_time || ""}` > `${ex.day} ${ex.time}`) Object.assign(ex, { ...row, name: betterName(ex.name, row.name), count: ex.count, firstDay: ex.firstDay });
          if (m.day < ex.firstDay) ex.firstDay = m.day;
        }
      }
    });
  }
  return [...byKey.values()].sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`));
}
