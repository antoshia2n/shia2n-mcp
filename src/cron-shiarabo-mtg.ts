/**
 * Cron ジョブ：面談の予定を毎日読んで、しあらぼ管理の最終面談日へ反映する
 *
 * cron `0,30 * * * *` の UTC 22:30（JST 07:30）分岐からのみ呼ばれる。
 * cron の枠は増やしていない（既存の 2 本に相乗り）。
 * 依頼書：https://www.notion.so/3ca9c6c1c43981fd9575e6e9fdb4059b
 *
 * ── なぜこれがあるか ──
 *   面談は毎回きちんと行われているのに、それが台帳の最終面談日へ届いていなかった。
 *   2026-08-28 の実測では、強化指定 9 名のうち 8 名がずれており、最大で 1 年 8 か月。
 *   手で埋め直しても同じことがまた起きるので、直すのは人ではなく線。
 *
 * ── 決まっていること（依頼書の 4 つ。動かさない） ──
 *   1. カレンダーを正にする。議事録はこの回では使わない
 *   2. 台帳の方が新しければ上書きしない
 *   3. 名前の欄は足さない。いまある名前で突き合わせる
 *   4. 通知は「強化指定かつ 2 か月空いた人」だけ（通知そのものは
 *      tools-shiarabo.ts の shiarabo__morning_line が受け持つ）
 *
 * ── 突き合わせの順（2026-08-28 に書き直した） ──
 *   依頼書には呼び名 display_name と本名 real_name の 2 欄で照らすと書いてあったが、
 *   実物にその 2 欄は無い。名前の欄は `name` の 1 つだけで、その中に呼び名と本名が
 *   一緒に入っている（例：ケン｜對木 拳）。そのままでは全件空振りして、しかも
 *   静かに 0 件で終わるので、欄が 1 つである形に直した。新しい欄は足していない。
 *
 *     1. 予定名が name と完全一致
 *     2. name を「｜」で割ったかたまりが、予定名と完全一致
 *     3. そのかたまりが予定名に含まれる／予定名がそれに含まれる
 *     4. 候補が 2 人以上になったら拾わない（理由を残す）
 *     5. どれにも当たらなければ拾わない
 *
 *   4 を置いたのは、短い名前（ひろ・とむ など）が別の人の名前や、生徒でない予定に
 *   入り込むため。当てにいって間違えるより、拾わずに残すほうが安全。
 *
 * ── 拾わなかった予定の行き先 ──
 *   shr_unmatched_events に理由付きで残す。消さない。
 *   生徒なのに拾えていない予定があったとき、ここを見れば分かる。
 *   自動で動くものの実行記録は直近 5 件しか残らないので、そちらには置かない。
 *
 * ── 落ちたときの扱い ──
 *   カレンダーが読めない・生徒が 0 件のときは、何も書かずに throw する。
 *   途中まで書いた状態を残さないため。1 人ずつの書き込みで失敗したものは
 *   数えて戻り値に載せ、残りは続ける（1 人のせいで全員止めない）。
 */

import type { Env } from "./index.js";
import {
  listEvents,
  toJstDate,
  jstDayShift,
  DEFAULT_MTG_CALENDAR_ID,
  type CalendarEvent,
} from "./google-calendar.js";

/** 何日ぶんさかのぼって見るか。取りこぼした日があっても翌日に拾い直せる幅 */
const LOOKBACK_DAYS = 14;

type Row = Record<string, unknown>;

// ─── Supabase ────────────────────────────────────────────────────────────────

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase から読めません（${res.status}）：${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase へ書けません（${res.status}）：${await res.text()}`);
}

/** 同じ鍵の行があれば上書きする形で入れる */
async function sbUpsert(env: Env, path: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`拾わなかった予定が書けません（${res.status}）：${await res.text()}`);
}

// ─── 突き合わせ ──────────────────────────────────────────────────────────────

/** 名前の欄から、照らすかたまりを取り出す（全体＋「｜」で割った各かたまり） */
export function nameParts(name: string): string[] {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(/[｜|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const all = [trimmed, ...parts];
  return [...new Set(all)];
}

export interface StudentLike {
  id: number;
  name: string;
}

export type MatchResult =
  | { kind: "hit"; student: StudentLike }
  | { kind: "miss"; reason: string };

/**
 * 予定名から生徒を 1 人に決める。決まらなければ理由を返す。
 * 候補が 2 人以上になったものは拾わない。
 */
export function matchStudent(summary: string, students: StudentLike[]): MatchResult {
  const title = (summary ?? "").trim();
  if (!title) return { kind: "miss", reason: "予定の名前が空" };

  // 手順 1・2：完全一致（全体でも、割ったかたまりでも）
  const exact = students.filter((s) => nameParts(s.name).some((p) => p === title));
  if (exact.length === 1) return { kind: "hit", student: exact[0] };
  if (exact.length > 1) {
    return { kind: "miss", reason: `完全一致の候補が ${exact.length} 人（${exact.map((s) => s.name).join("・")}）` };
  }

  // 手順 3：含む・含まれる
  const partial = students.filter((s) =>
    nameParts(s.name).some((p) => title.includes(p) || p.includes(title))
  );
  if (partial.length === 1) return { kind: "hit", student: partial[0] };
  if (partial.length > 1) {
    return { kind: "miss", reason: `候補が ${partial.length} 人（${partial.map((s) => s.name).join("・")}）` };
  }

  return { kind: "miss", reason: "台帳の名前に当たらない" };
}

// ─── 本体 ────────────────────────────────────────────────────────────────────

export async function handleShiaraboMtgSync(
  env: Env
): Promise<{ count: number; detail: string }> {
  const calendarId = env.MTG_CALENDAR_ID || DEFAULT_MTG_CALENDAR_ID;
  const now = new Date();

  // 1. 生徒を読む（在籍だけ。生徒一覧の口と同じ絞り方）
  const students = await sbGet(env, "/shr_students?select=*&archived=eq.false");
  if (students.length === 0) {
    throw new Error("在籍の生徒が 0 件で返りました。書かずに止めます");
  }

  // 使う欄が実物にあるかを先に見る。無い欄を静かに undefined で扱うと、
  // 突き合わせが全件空振りしても 0 件成功に見えてしまう。
  const first = students[0];
  const required = ["id", "name", "last_mtg"];
  const missing = required.filter((k) => !(k in first));
  if (missing.length > 0) {
    throw new Error(
      `生徒の行に要る欄がありません（${missing.join("・")}）。実物の欄：${Object.keys(first).join("・")}`
    );
  }

  const list: StudentLike[] = students.map((r) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
  }));
  const lastMtgById = new Map<number, string>(
    students.map((r) => [Number(r.id), String(r.last_mtg ?? "")])
  );

  // 2. 予定を読む
  const timeMin = jstDayShift(now, -LOOKBACK_DAYS);
  const timeMax = jstDayShift(now, 1);
  const events: CalendarEvent[] = await listEvents(env, calendarId, timeMin, timeMax);

  // 3. 突き合わせる
  const newest = new Map<number, string>(); // 生徒 id → その期間で一番新しい面談日
  const unmatched: Row[] = [];
  const recordedAt = new Date().toISOString();

  for (const ev of events) {
    const m = matchStudent(ev.summary, list);
    if (m.kind === "hit") {
      const prev = newest.get(m.student.id);
      if (!prev || ev.startDate > prev) newest.set(m.student.id, ev.startDate);
    } else {
      unmatched.push({
        event_id: ev.id,
        event_title: ev.summary,
        event_date: ev.startDate,
        reason: m.reason,
        recorded_at: recordedAt,
      });
    }
  }

  // 4. 最終面談日を入れる（台帳の方が新しければ書かない・同じ日なら書かない）
  let updated = 0;
  let kept = 0;
  const failed: string[] = [];

  for (const [id, date] of newest) {
    const current = lastMtgById.get(id) ?? "";
    if (current && current >= date) {
      kept++;
      continue;
    }
    try {
      await sbPatch(env, `/shr_students?id=eq.${id}`, {
        last_mtg: date,
        updated_at: new Date().toISOString(),
      });
      updated++;
    } catch (e) {
      failed.push(`id=${id}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5. 拾わなかった予定を残す
  await sbUpsert(env, "/shr_unmatched_events?on_conflict=event_id", unmatched);

  const detail =
    `予定 ${events.length} 件を見て、当たった生徒 ${newest.size} 名。` +
    `最終面談日を入れた ${updated} 名・台帳の方が新しいので入れなかった ${kept} 名。` +
    `拾わなかった予定 ${unmatched.length} 件を残しました（カレンダー ${calendarId}・${toJstDate(timeMin)} 〜 ${toJstDate(now)}）` +
    (failed.length > 0 ? `。書けなかった生徒 ${failed.length} 名：${failed.join(" / ")}` : "");

  return { count: updated, detail };
}
