/**
 * shia2n-mcp / src/ical-day.ts / 新設（2026-10-13 v1.15.0 開発部）
 *
 * Google カレンダーの「iCal 形式の非公開アドレス」から、日本時間の 1 日に重なる予定だけを取り出す。読むだけ。
 * 依頼：https://www.notion.so/3f89c6c1c43981308c9dc4e780af3f0d（その日の記録の「予定」）
 *
 * 決め
 *   - 束（数 MB になる）を全部ためずに、届いた順に 1 件ずつ読む（haAku #23 と同じ考え方）
 *   - 繰り返し（RRULE）は、その日の前後だけを照らして広げる。DAILY・WEEKLY・MONTHLY・YEARLY と
 *     INTERVAL・COUNT・UNTIL・BYDAY・BYMONTHDAY・BYMONTH・WKST・EXDATE・RDATE・RECURRENCE-ID（動かした回・取り消した回）を読む
 *   - 読めない形（BYSETPOS・BYWEEKNO・BYYEARDAY・BYHOUR などの時刻の繰り返し・RANGE=THISANDFUTURE・知らない時間帯）は
 *     推測で広げず、その予定を「読めない」に数えて外す
 *   - 取り消した予定（STATUS:CANCELLED）は出さない
 *   - Cloudflare の実行環境は fetch の redirect:'error' と cache を受け付けない（haAku #24 で分かった）。redirect は manual・cache は付けない
 */

export type DayEvent = {
  uid: string;
  title: string;
  start: string;      // 日本時間の ISO（終日は YYYY-MM-DD）
  end: string;
  all_day: boolean;
  time: string;       // "13:00〜14:00" か "終日"
  location?: string;
  calendar?: string;
};
export type DayResult = { events: DayEvent[]; unreadable: number; scanned: number };

const DAY_MS = 86400000;
const JST = "Asia/Tokyo";

// ── 時間帯 ──────────────────────────────────────────────
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}
export function validTz(tz: string): boolean {
  try { fmt(tz); return true; } catch { return false; }
}
function offsetMs(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** その時間帯の壁時計の時刻を、世界の時刻（ms）に直す */
export function zonedMs(dn: number, sec: number, tz: string): number {
  const guess = dn * DAY_MS + sec * 1000;
  if (tz === "UTC") return guess;
  if (tz === JST) return guess - 9 * 3600000; // 日本時間は夏時間が無いので計算だけで済ませる（速さのため）
  const o1 = offsetMs(guess, tz);
  const t = guess - o1;
  const o2 = offsetMs(t, tz);
  return o2 === o1 ? t : guess - o2;
}
/** 世界の時刻を日本時間の "YYYY-MM-DDTHH:mm:ss+09:00" に */
export function jstIso(ms: number): string {
  const d = new Date(ms + 9 * 3600000);
  return d.toISOString().slice(0, 19) + "+09:00";
}
export const dnOf = (ymd: string) => Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY_MS);
export const ymdOf = (dn: number) => new Date(dn * DAY_MS).toISOString().slice(0, 10);
const wdOf = (dn: number) => ((dn % 7) + 11) % 7; // 1970-01-01 は木曜（4）
/** 日の番号から年月日と曜日（Date を作らない計算・繰り返しを数えるときに何千回も呼ぶため） */
function civil(dn: number) {
  const z = dn + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d, wd: wdOf(dn) };
}
const daysInMonth = (y: number, m: number) => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

// ── 1 行の読み方 ────────────────────────────────────────
type Prop = { name: string; params: Record<string, string>; value: string };
export function parseLine(line: string): Prop | null {
  let inQ = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = ""; inQ = false;
  for (const c of head) {
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ";" && !inQ) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) { const e = p.indexOf("="); if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1); }
  return { name: parts[0].toUpperCase(), params, value };
}
const unescapeText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

type When = { dn: number; sec: number; allDay: boolean; tz: string };
/** DTSTART などの値。読めなければ null */
export function parseWhen(p: Prop): When | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const dn = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
  if (!m[4]) return { dn, sec: 0, allDay: true, tz: JST };
  const sec = +m[4] * 3600 + +m[5] * 60 + +m[6];
  if (m[7]) return { dn, sec, allDay: false, tz: "UTC" };
  const tz = p.params.TZID ? p.params.TZID.replace(/^\//, "") : JST; // 時間帯なし（浮いた時刻）は日本時間として読む
  if (!validTz(tz)) return null;
  return { dn, sec, allDay: false, tz };
}
const whenMs = (w: When) => zonedMs(w.dn, w.sec, w.tz);

// ── 繰り返し ────────────────────────────────────────────
type Rule = { freq: string; interval: number; count?: number; untilMs?: number; untilDn?: number;
  byday?: { n: number; wd: number }[]; bymonthday?: number[]; bymonth?: number[]; wkst: number };
const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export function parseRule(v: string): Rule | null {
  const o: Record<string, string> = {};
  for (const kv of v.split(";")) { const e = kv.indexOf("="); if (e > 0) o[kv.slice(0, e).toUpperCase()] = kv.slice(e + 1); }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(o.FREQ)) return null;
  for (const k of ["BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYHOUR", "BYMINUTE", "BYSECOND"]) if (o[k] !== undefined) return null;
  const r: Rule = { freq: o.FREQ, interval: Math.max(1, Number(o.INTERVAL || 1) || 1), wkst: WD[o.WKST ?? "MO"] ?? 1 };
  if (o.COUNT) r.count = Number(o.COUNT);
  if (o.UNTIL) {
    const u = parseWhen({ name: "UNTIL", params: {}, value: o.UNTIL });
    if (!u) return null;
    if (u.allDay) r.untilDn = u.dn; else r.untilMs = whenMs(u);
  }
  if (o.BYDAY) {
    r.byday = [];
    for (const x of o.BYDAY.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim());
      if (!m) return null;
      r.byday.push({ n: m[1] ? Number(m[1]) : 0, wd: WD[m[2]] });
    }
  }
  if (o.BYMONTHDAY) r.bymonthday = o.BYMONTHDAY.split(",").map(Number);
  if (o.BYMONTH) r.bymonth = o.BYMONTH.split(",").map(Number);
  if (r.byday?.some(b => b.n !== 0) && (r.freq === "DAILY" || r.freq === "WEEKLY")) return null;
  if (r.freq === "YEARLY" && r.byday?.some(b => b.n !== 0) && !r.bymonth) return null; // 年の中の何番目の曜日は読まない
  return r;
}

function nthOk(n: number, wd: number, c: { y: number; m: number; d: number; wd: number }): boolean {
  if (c.wd !== wd) return false;
  if (n === 0) return true;
  if (n > 0) return Math.ceil(c.d / 7) === n;
  return Math.ceil((daysInMonth(c.y, c.m) - c.d + 1) / 7) === -n;
}
const mdayOk = (list: number[], c: { y: number; m: number; d: number }) =>
  list.some(v => (v > 0 ? v === c.d : daysInMonth(c.y, c.m) + v + 1 === c.d));

/** dn（その予定の時間帯の日付）が規則に当たるか。COUNT と UNTIL はここでは見ない */
export function ruleHits(r: Rule, s: When, dn: number): boolean {
  if (dn < s.dn) return false;
  const c = civil(dn), c0 = civil(s.dn);
  if (r.bymonth && !r.bymonth.includes(c.m)) return false;
  switch (r.freq) {
    case "DAILY":
      if ((dn - s.dn) % r.interval) return false;
      if (r.byday && !r.byday.some(b => b.wd === c.wd)) return false;
      if (r.bymonthday && !mdayOk(r.bymonthday, c)) return false;
      return true;
    case "WEEKLY": {
      const align = (x: number) => x - ((wdOf(x) - r.wkst + 7) % 7);
      if (((align(dn) - align(s.dn)) / 7) % r.interval) return false;
      const days = r.byday ? r.byday.map(b => b.wd) : [c0.wd];
      return days.includes(c.wd);
    }
    case "MONTHLY": {
      if (((c.y - c0.y) * 12 + (c.m - c0.m)) % r.interval) return false;
      if (r.byday) return r.byday.some(b => nthOk(b.n, b.wd, c)) && (!r.bymonthday || mdayOk(r.bymonthday, c));
      if (r.bymonthday) return mdayOk(r.bymonthday, c);
      return c.d === c0.d;
    }
    case "YEARLY": {
      if ((c.y - c0.y) % r.interval) return false;
      if (!r.bymonth && c.m !== c0.m) return false;
      if (r.byday) return r.byday.some(b => nthOk(b.n, b.wd, c)) && (!r.bymonthday || mdayOk(r.bymonthday, c));
      if (r.bymonthday) return mdayOk(r.bymonthday, c);
      return c.d === c0.d;
    }
  }
  return false;
}

// ── 1 件の予定 ──────────────────────────────────────────
type Ev = { uid: string; title: string; location: string; status: string; start: When | null; end: When | null; durSec: number | null;
  rrule: string | null; exdates: When[]; rdates: When[]; recId: When | null; recRange: string; bad: boolean };

function readEvent(lines: string[]): Ev {
  const e: Ev = { uid: "", title: "", location: "", status: "", start: null, end: null, durSec: null, rrule: null, exdates: [], rdates: [], recId: null, recRange: "", bad: false };
  for (const l of lines) {
    const p = parseLine(l);
    if (!p) continue;
    switch (p.name) {
      case "UID": e.uid = p.value; break;
      case "SUMMARY": e.title = unescapeText(p.value); break;
      case "LOCATION": e.location = unescapeText(p.value); break;
      case "STATUS": e.status = p.value.toUpperCase(); break;
      case "DTSTART": e.start = parseWhen(p); if (!e.start) e.bad = true; break;
      case "DTEND": e.end = parseWhen(p); if (!e.end) e.bad = true; break;
      case "DURATION": {
        const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(p.value.trim());
        if (m) e.durSec = (+(m[1] || 0) * 7 + +(m[2] || 0)) * 86400 + +(m[3] || 0) * 3600 + +(m[4] || 0) * 60 + +(m[5] || 0);
        else e.bad = true;
        break;
      }
      case "RRULE": e.rrule = p.value; break;
      case "EXDATE": case "RDATE":
        for (const v of p.value.split(",")) {
          const w = parseWhen({ ...p, value: v });
          if (!w) { e.bad = true; continue; }
          (p.name === "EXDATE" ? e.exdates : e.rdates).push(w);
        }
        break;
      case "RECURRENCE-ID": e.recId = parseWhen(p); e.recRange = (p.params.RANGE ?? "").toUpperCase(); if (!e.recId) e.bad = true; break;
    }
  }
  return e;
}

const keyOf = (uid: string, w: When) => uid + "|" + (w.allDay ? "D" + w.dn : String(whenMs(w)));

type Cand = { key: string; ev: DayEvent };

/** 1 件の予定を、その日の候補にする。base は繰り返しの元（動かした回・取り消した回は override で別に入る） */
function candidates(e: Ev, target: number, dayStart: number, dayEnd: number): Cand[] | "bad" | [] {
  if (e.bad || !e.start) return "bad";
  const s = e.start;
  const out: Cand[] = [];
  const durSec = e.end ? (s.allDay ? (e.end.dn - s.dn) * 86400 : Math.round((whenMs(e.end) - whenMs(s)) / 1000)) : (e.durSec ?? (s.allDay ? 86400 : 0));
  const durDays = Math.max(1, Math.ceil(durSec / 86400));
  const mk = (dn: number): Cand | null => {
    const inst: When = { ...s, dn };
    if (s.allDay) {
      const endDn = dn + Math.max(1, Math.round(durSec / 86400));
      if (!(dn <= target && endDn > target)) return null;
      return { key: keyOf(e.uid, inst), ev: { uid: e.uid, title: e.title, start: ymdOf(dn), end: ymdOf(endDn), all_day: true, time: "終日", ...(e.location ? { location: e.location } : {}) } };
    }
    const a = whenMs(inst), b = a + durSec * 1000;
    const hit = b > a ? a < dayEnd && b > dayStart : a >= dayStart && a < dayEnd;
    if (!hit) return null;
    const hm = (ms: number) => jstIso(ms).slice(11, 16);
    return { key: keyOf(e.uid, inst), ev: { uid: e.uid, title: e.title, start: jstIso(a), end: jstIso(b), all_day: false, time: hm(a) + "〜" + hm(b), ...(e.location ? { location: e.location } : {}) } };
  };
  // 調べる日付（予定の時間帯の日付）：日本時間の 1 日に重なりうる幅
  const lo = target - durDays - 1, hi = target + 1;
  if (!e.rrule || e.recId) {
    if ((s.dn < lo || s.dn > hi) && !e.rdates.length) return []; // 遠い日の 1 回きりの予定は時刻の計算をしない（速さのため）
    const c = mk(s.dn);
    if (c) out.push(c);
    for (const r of e.rdates) { const c2 = mk(r.dn); if (c2) out.push(c2); }
    return out;
  }
  const rule = parseRule(e.rrule);
  if (!rule) return "bad";
  const ex = new Set(e.exdates.map(w => (w.allDay ? "D" + w.dn : String(whenMs(w)))));
  const okUntil = (dn: number) => (rule.untilDn !== undefined ? dn <= rule.untilDn : rule.untilMs !== undefined ? whenMs({ ...s, dn }) <= rule.untilMs : true);
  for (let dn = Math.max(lo, s.dn); dn <= hi; dn++) {
    const first = dn === s.dn;
    if (!first && !ruleHits(rule, s, dn)) continue;
    if (!okUntil(dn)) continue;
    if (rule.count !== undefined) {
      // その回が何回目か（DTSTART が 1 回目）。当たった回だけ数える
      let n = 0;
      for (let x = s.dn; x <= dn && n <= rule.count; x++) if (x === s.dn || ruleHits(rule, s, x)) n++;
      if (n > rule.count) continue;
    }
    const inst: When = { ...s, dn };
    if (ex.has(s.allDay ? "D" + dn : String(whenMs(inst)))) continue;
    const c = mk(dn);
    if (c) out.push(c);
  }
  for (const r of e.rdates) { const c2 = mk(r.dn); if (c2) out.push(c2); }
  return out;
}

/** 届いた順の文字の流れを、予定 1 件ずつ（VEVENT の行の並び）に分けて渡す。読めないほど長い予定は onBad */
async function scanEvents(chunks: AsyncIterable<string> | Iterable<string>, onEvent: (lines: string[]) => void, onBad: () => void): Promise<void> {
  let buf = "", cur: string[] | null = null, last: string | null = null;
  const flushLine = (line: string) => {
    if (line === "BEGIN:VEVENT") { cur = []; return; }
    if (line === "END:VEVENT") {
      if (!cur) return;
      const lines = cur;
      cur = null;
      onEvent(lines);
      return;
    }
    if (cur) {
      if (cur.length > 2000) { cur = null; onBad(); return; }
      cur.push(line);
    }
  };
  const take = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(" ") || line.startsWith("\t")) { if (last !== null) last += line.slice(1); return; }
    if (last !== null) flushLine(last);
    last = line;
  };
  for await (const chunk of chunks as AsyncIterable<string>) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > 2_000_000) throw new Error("1 行が長すぎます（2,000,000 文字を超えた）。読むのを止めました");
  }
  if (buf) take(buf);
  if (last !== null) flushLine(last);
}

/** 候補から、動かした回・取り消した回の元の回を外し、同じ回を 1 つにして並べる */
function finishEvents(cands: Cand[], overrides: Set<string>): DayEvent[] {
  const seen = new Set<string>();
  const events: DayEvent[] = [];
  for (const c of cands) {
    if (!c.key.startsWith("override|") && overrides.has(c.key)) continue;
    const k = c.key.replace(/^override\|/, "") + "|" + c.ev.start;
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(c.ev);
  }
  events.sort((a, b) => (a.all_day === b.all_day ? a.start.localeCompare(b.start) : a.all_day ? -1 : 1) || a.title.localeCompare(b.title, "ja"));
  return events;
}

/**
 * 届いた順の文字の流れから、日本時間 day（YYYY-MM-DD）に重なる予定を返す
 */
export async function eventsOnDay(chunks: AsyncIterable<string> | Iterable<string>, day: string): Promise<DayResult> {
  const target = dnOf(day);
  const dayStart = zonedMs(target, 0, JST), dayEnd = zonedMs(target + 1, 0, JST);
  const overrides = new Set<string>();          // 動かした回・取り消した回の元の時刻
  const cands: Cand[] = [];
  let unreadable = 0, scanned = 0;
  await scanEvents(chunks, lines => {
    scanned++;
    const e = readEvent(lines);
    if (e.recId) {
      if (e.recRange === "THISANDFUTURE") { unreadable++; return; }
      overrides.add(keyOf(e.uid, e.recId));
    }
    if (e.status === "CANCELLED") return;
    const c = candidates(e, target, dayStart, dayEnd);
    if (c === "bad") { unreadable++; return; }
    // 動かした回は「元の回」を消す側にも、「新しい回」として出す側にも入る。元の回と区別するため鍵に印を付ける
    for (const x of c) cands.push(e.recId ? { key: "override|" + x.key, ev: x.ev } : x);
  }, () => { unreadable++; });
  return { events: finishEvents(cands, overrides), unreadable, scanned };
}

/**
 * v1.42.0：題名が keep に当たる予定を、days（日本時間の日付の並び・最大 92 日）の各日について返す。文字の流れは 1 回だけ読む。
 * 動かした回・取り消した回は eventsOnDay と同じに扱う（元の回を消す印は、題名に関係なくすべての予定から集める）
 */
export async function eventsOnDays(chunks: AsyncIterable<string> | Iterable<string>, days: string[], keep: (title: string) => boolean): Promise<DayResult> {
  if (days.length > 92) throw new Error("一度に調べられるのは 92 日までです");
  const overrides = new Set<string>();
  const kept: Ev[] = [];
  let unreadable = 0, scanned = 0;
  await scanEvents(chunks, lines => {
    scanned++;
    const e = readEvent(lines);
    if (e.recId) {
      if (e.recRange === "THISANDFUTURE") { unreadable++; return; }
      overrides.add(keyOf(e.uid, e.recId));
    }
    if (e.status === "CANCELLED") return;
    if (!keep(e.title)) return;
    kept.push(e);
  }, () => { unreadable++; });
  const cands: Cand[] = [];
  const bad = new Set<Ev>();
  for (const day of days) {
    const target = dnOf(day);
    const dayStart = zonedMs(target, 0, JST), dayEnd = zonedMs(target + 1, 0, JST);
    for (const e of kept) {
      if (bad.has(e)) continue;
      const c = candidates(e, target, dayStart, dayEnd);
      if (c === "bad") { bad.add(e); continue; }
      for (const x of c) cands.push(e.recId ? { key: "override|" + x.key, ev: x.ev } : x);
    }
  }
  return { events: finishEvents(cands, overrides), unreadable: unreadable + bad.size, scanned };
}

/** 非公開アドレスの中身を、届いた順の文字の流れで返す。アドレスは返事・エラー文に出さない */
async function openCalendar(url: string): Promise<{ chunks: AsyncIterable<string>; bytes: () => number; http: number }> {
  if (!/^https:\/\//.test(url)) throw new Error("保存したアドレスが https ではありません");
  const res = await fetch(url, { method: "GET", redirect: "manual", headers: { Accept: "text/calendar", "Cache-Control": "no-store" } });
  if (res.status !== 200 || !res.body) throw new Error("カレンダーが読めませんでした（HTTP " + res.status + "）");
  let bytes = 0;
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  async function* chunks() {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { const t = dec.decode(); if (t) yield t; return; }
      bytes += value.byteLength;
      yield dec.decode(value, { stream: true });
    }
  }
  return { chunks: chunks(), bytes: () => bytes, http: res.status };
}

/** 非公開アドレスを読む。アドレスは返事・エラー文に出さない */
export async function fetchDayEvents(url: string, day: string): Promise<DayResult & { bytes: number; http: number }> {
  const c = await openCalendar(url);
  const r = await eventsOnDay(c.chunks, day);
  return { ...r, bytes: c.bytes(), http: c.http };
}

/** v1.42.0：非公開アドレスを 1 回読み、題名が keep に当たる予定を days の各日について返す */
export async function fetchEventsOnDays(url: string, days: string[], keep: (title: string) => boolean): Promise<DayResult & { bytes: number; http: number }> {
  const c = await openCalendar(url);
  const r = await eventsOnDays(c.chunks, days, keep);
  return { ...r, bytes: c.bytes(), http: c.http };
}
