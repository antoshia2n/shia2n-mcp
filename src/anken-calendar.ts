/**
 * shia2n-mcp / src/anken-calendar.ts / 新設（2026-10-25 v1.42.0 開発部・週間レポートの口 便 3）
 *
 * 案件くんの「次の MTG」を、Google カレンダーの予定から取る。
 * 依頼：https://app.notion.com/p/4049c6c1c439810e9935de14c976bf39
 *
 *   ・読むのは haAku に保存した非公開アドレス（os_calendar_private_v1・メインと UTAGE）。haAku の「その日の記録」と同じ置き場
 *   ・当てる決まり：予定の名前に案件の名前と「定例」の両方が入っているもの（例「るーみん定例」）。全角半角・大文字小文字・空白の違いは同じとみなす
 *   ・今より後に終わる回のうち、いちばん早いもの。繰り返しの回を動かしたもの・取り消したものは ical-day.ts と同じに扱う
 *   ・見つからない案件は、今までどおり AI が書いた推定（ak_cases.mtg.when）を使う
 *   ・名前の違う予定（例：おかぜりの「るりさん＠…」）は結ばない（2026-10-25 Naoki「OK」の作る前の 1 枚）
 */
import type { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { readValue, jstToday } from "./haaku-home-store.js";
import { calendarsOf } from "./haaku-day-record.js";
import { fetchEventsOnDays, type DayEvent } from "./ical-day.js";

/** 先を見る日数（今日を含む） */
export const LOOK_AHEAD_DAYS = 42;
const WD = ["日", "月", "火", "水", "木", "金", "土"];

export const normName = (s: string) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");

/** 予定の名前が、その案件の定例か */
export function isCaseMeeting(caseName: string, title: string): boolean {
  const n = normName(caseName), t = normName(title);
  return !!n && t.includes(n) && t.includes("定例");
}

/** 今より後に終わる回のうち、いちばん早いもの（終日の予定は今日以降の日） */
export function pickNext(events: DayEvent[], nowMs: number): DayEvent | null {
  const today = jstToday(new Date(nowMs));
  const live = events.filter(e => (e.all_day ? e.start >= today : Date.parse(e.end) > nowMs));
  live.sort((a, b) => (a.all_day ? a.start + "T00:00:00+09:00" : a.start).localeCompare(b.all_day ? b.start + "T00:00:00+09:00" : b.start));
  return live[0] ?? null;
}

/** 推定と同じ書き方：「2026-10-29（木）15時」「2026-10-29（木）15時30分」「2026-10-29（木）」 */
export function whenText(e: DayEvent): string {
  const day = e.start.slice(0, 10);
  const wd = WD[new Date(day + "T00:00:00Z").getUTCDay()];
  if (e.all_day) return `${day}（${wd}）`;
  const h = Number(e.start.slice(11, 13)), m = Number(e.start.slice(14, 16));
  return `${day}（${wd}）${h}時${m ? m + "分" : ""}`;
}

export type CalendarMeeting = { when: string; day: string; title: string; start: string; calendar: string };
export type CalendarResult = { found: Map<string, CalendarMeeting>; note: string };

/** 今日から先の日付の並び */
function nextDays(nowMs: number, n: number): string[] {
  const first = jstToday(new Date(nowMs));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.parse(first + "T00:00:00Z") + i * 86400000).toISOString().slice(0, 10));
  return out;
}

/** 計算だけ：読んだ予定（カレンダーの名前つき）から、案件ごとの次の定例を決める */
export function meetingsFor(caseNames: string[], events: (DayEvent & { calendar?: string })[], nowMs: number): Map<string, CalendarMeeting> {
  const found = new Map<string, CalendarMeeting>();
  for (const name of caseNames) {
    const ev = pickNext(events.filter(e => isCaseMeeting(name, e.title)), nowMs);
    if (ev) found.set(name, { when: whenText(ev), day: ev.start.slice(0, 10), title: ev.title, start: ev.start, calendar: ev.calendar ?? "" });
  }
  return found;
}

/** 案件の名前の並びについて、予定表から次の定例を探す。読めなくても止めない（note に理由・found は空） */
export async function calendarMeetings(env: Env, caseNames: string[], nowMs = Date.now()): Promise<CalendarResult> {
  const names = caseNames.filter(n => normName(n));
  if (!names.length) return { found: new Map(), note: "案件の名前が無い" };
  try {
    if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) return { found: new Map(), note: "予定表を読む設定が無い" };
    const token = await getFirestoreToken(env);
    const list = calendarsOf((await readValue(token, env.NAOKI_UID, "os_calendar_private_v1")).value);
    if (!list.length) return { found: new Map(), note: "haAku につないだカレンダーが無い" };
    const days = nextDays(nowMs, LOOK_AHEAD_DAYS);
    const keep = (title: string) => names.some(n => isCaseMeeting(n, title));
    const events: (DayEvent & { calendar: string })[] = [];
    const bad: string[] = [];
    for (const c of list) {
      try {
        const r = await fetchEventsOnDays(c.url, days, keep);
        for (const e of r.events) events.push({ ...e, calendar: c.name });
      } catch (e) {
        bad.push(c.name + "：" + (e instanceof Error ? e.message : String(e)).slice(0, 120));
      }
    }
    const found = meetingsFor(names, events, nowMs);
    return { found, note: `予定表（${list.map(c => c.name).join("・")}）の ${days[0]}〜${days[days.length - 1]} から探した` + (bad.length ? `。読めなかった：${bad.join("／")}` : "") };
  } catch (e) {
    return { found: new Map(), note: "予定表を読めなかった：" + (e instanceof Error ? e.message : String(e)).slice(0, 160) };
  }
}
