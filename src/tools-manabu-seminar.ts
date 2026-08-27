/**
 * 学ぶくん：セミナーアーカイブを入れる道具（2026-08-24）
 * tools-manabu-seminar.ts
 *
 * v0.3.0（2026-08-24・統括の判定 10〜13）：棚の名前と、同じ行かどうかの鍵を選べるようにし、
 *   読む口と直す口を 1 本ずつ足した。
 *   ・A：mn__put_seminar に course_title（棚の名前をそのまま指定）と
 *        match_by（同じ行かどうかの鍵：date か video_url）を足した。
 *        あわせて 1 行ごとの order_index と、日付の呼び名（date_label）も渡せるようにした。
 *        年の棚しか作れず、鍵が日付に固定されていたため、
 *        「その他のアーカイブ」を作ることも、同じ公開日の行を入れることもできなかった。
 *   ・B：mn__video_urls を新設。今の棚が持っている動画の番号を返す（読むだけ）。
 *        YouTube の全件から棚にある分を引いて、原稿に無い本数を機械で確定するために使う。
 *   ・C：mn__fix_backslash を新設。本文と説明の中の「\#」を「#」に直す（読み書き両方・dry_run あり）。
 *        原稿を文章の形で取り出すと「#」の前に逆斜線が付くため、
 *        入れた行のタグに残っている可能性がある。残っているかを読む口が無いので、
 *        直す口が同時に「何件変わったか」を返す形にしてある。
 *
 * ★ 鍵に video_url を使うのは、原稿に無い動画（その他のアーカイブ）を入れるときだけにする。
 *   すでに入っている年の棚の 142 行には、同じ動画を指す行が 1 組ある
 *   （2025 年 9/23 わかりやすい説明の基本 ／ 9/24 努力を習慣にするマインドセット）。
 *   この鍵で 142 行を流し直すと、その組が 1 本に潰れて 2025 年が 73 から 72 になる。
 *   年の棚を入れ直すときは match_by を date のままにすること（統括の判定 12・2026-08-24）。
 *
 * v0.2.0（2026-08-24）：日付を題名から外した。あわせてまとめて入れられるようにした。
 *   ・題名は題名だけにする。日付は「説明」の先頭と本文の先頭に置く。
 *     学ぶくんに日付の欄が無く、一覧の札は題名とその下の説明の 2 行で出るため、
 *     説明の先頭に置くと題名とは別の行に日付が出る。
 *   ・同じものかどうかの見分けを、題名から日付に変えた。
 *     題名を後から直しても同じ 1 件として扱われ、二重にならない。
 *     日付は並び順の欄に 20240110 の形で入れてあるので、そこで見分ける。
 *   ・1 回の呼び出しで最大 50 本まで入るようにした（142 本を 142 回にしないため）。
 *
 * ── なぜこの形か ──
 * 学ぶくんの画面は自前の口（functions/api/internal）を通っており、その口は
 * Firebase のログインの証明を要求する。MCP 側からその証明は作れないので、
 * ここでは画面と同じ表へ Supabase 経由で直接書く（画面の口は使わない）。
 *
 * 画面の実物から確かめた並び（2026-08-24）：
 *   カリキュラム → プログラム → コース → コンテンツ
 *   学ぶ人に配られる単位はカリキュラム。プログラムをカリキュラムに結ぶと、
 *   その下のコースとコンテンツが全部見えるようになる。
 *
 * コンテンツの本文（body_markdown）は、ただの文章ではなく次の合図を解釈する：
 *   {{youtube:動画ID}}                     … 画面の中で再生できる形になる
 *   {{linkcard:URL|題名|説明|画像URL}}      … 大きなカードになる
 *   {{linkset_inline}} … {{/linkset_inline}} … 中の [題名](URL) の行が一覧になる
 * さらに linkset_data に中身が入っていると本文は一切描かれないので、
 * ここでは linkset_data を必ず空（null）にする。
 *
 * タグを入れる専用の欄は学ぶくんに無い（44 本の口の全文で 0 件・2026-08-24）。
 * 学ぶ人の検索は mn_contents の title / description / body_markdown の 3 つを
 * 見ているので、タグは本文の末尾に置く。そうすればタグで引ける。
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";

/** 学ぶくんの表のうち、この道具が触るもの */
const T_PROGRAMS = "mn_programs";
const T_COURSES = "mn_courses";
const T_CONTENTS = "mn_contents";
const T_CURRICULUMS = "mn_curriculums";
const T_CURRICULUM_PROGRAMS = "mn_curriculum_programs";
const T_MEMBER_CURRICULUMS = "mn_member_curriculums";
const T_CONTENT_COURSES = "mn_content_courses";

/** 1 回の呼び出しで入れられる上限 */
const MAX_ROWS = 50;

/** 説明の欄に入れる長さの上限 */
const DESC_MAX = 200;

/** 直す対象の 2 文字。ここを広げない（広げると原稿の意図した文字まで消える） */
const BACKSLASH_HASH = "\\#";

function sbHeaders(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sbGet(env: Env, path: string): Promise<any[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) {
    throw new Error(`取得できませんでした（${path} / ${res.status} / ${await res.text()}）`);
  }
  return (await res.json()) as any[];
}

/**
 * 1000 行ずつ最後まで取る。
 * sbGet は 1 回きりの取得なので、PostgREST の既定の上限（1000 行）で黙って切れる。
 * 所属の表は 1 件のコンテンツにつき複数行になるため、切れると件数が過少に出る。
 */
async function sbGetAll(env: Env, path: string): Promise<any[]> {
  const pageSize = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...sbHeaders(env), Range: `${from}-${from + pageSize - 1}`, "Range-Unit": "items" },
    });
    if (!res.ok) {
      throw new Error(`取得できませんでした（${path} / ${res.status} / ${await res.text()}）`);
    }
    const rows = (await res.json()) as any[];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

/**
 * コースにどのコンテンツが入っているかの地図を作る。
 *
 * なぜ 2 か所を足すか：
 *   2026-08-27 に、1 件のコンテンツを複数のコースへ置ける形にして、所属を
 *   mn_content_courses へ移した。ただし mn_contents.course_id は残してあり、
 *   そのあとに入った行は course_id しか持たない。どちらか片方だけを見ると
 *   数が合わない。両方を足して、同じ組み合わせは 1 回だけ数える。
 */
async function courseMembership(
  env: Env,
  contents: Array<{ id: string; course_id?: string | null }>
): Promise<{ map: Map<string, Set<string>>; linkRows: number }> {
  const links = await sbGetAll(env, `${T_CONTENT_COURSES}?select=content_id,course_id`);
  const map = new Map<string, Set<string>>();
  const add = (courseId: unknown, contentId: unknown) => {
    if (!courseId || !contentId) return;
    const key = String(courseId);
    if (!map.has(key)) map.set(key, new Set<string>());
    map.get(key)!.add(String(contentId));
  };
  for (const l of links) add(l.course_id, l.content_id);
  for (const c of contents) add(c.course_id, c.id);
  return { map, linkRows: links.length };
}

async function sbInsert(env: Env, table: string, row: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`足せませんでした（${table} / ${res.status} / ${await res.text()}）`);
  }
  const rows = (await res.json()) as any[];
  return rows[0];
}

/**
 * 所属の表へ 1 組（コンテンツとコース）を入れる。既に同じ組があれば何もしない。
 *
 * なぜ要るか：
 *   2026-08-27 に所属を mn_content_courses へ移し、学ぶくんの画面はそちらを見る形にした。
 *   この道具は mn_contents.course_id にしか書いていなかったので、ここから入れた行だけが
 *   生徒の画面に出ないという穴が残っていた（2026-08-28 に見つけた）。
 */
async function sbLinkContentToCourse(
  env: Env,
  contentId: string,
  courseId: string,
  orderIndex: number | null
): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${T_CONTENT_COURSES}`, {
    method: "POST",
    headers: {
      ...sbHeaders(env),
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({ content_id: contentId, course_id: courseId, order_index: orderIndex }),
  });
  if (!res.ok) {
    throw new Error(
      `所属を入れられませんでした（${T_CONTENT_COURSES} / ${res.status} / ${await res.text()}）`
    );
  }
}

async function sbUpdateById(
  env: Env,
  table: string,
  id: string,
  row: Record<string, unknown>
): Promise<any> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders(env), Prefer: "return=representation" },
      body: JSON.stringify(row),
    }
  );
  if (!res.ok) {
    throw new Error(`書き換えられませんでした（${table} / ${res.status} / ${await res.text()}）`);
  }
  const rows = (await res.json()) as any[];
  return rows[0];
}

/** YouTube の住所から動画の番号を取り出す。取り出せなければ null */
function youtubeId(url: string | undefined): string | null {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * 入れてある本文から動画の番号を取り出す。
 * 本文には {{youtube:動画ID}} の形と、末尾の [YouTube で開く](住所) の形の
 * 両方が入りうるので、どちらからも拾う。見つからなければ null。
 */
function videoIdFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const tag = body.match(/\{\{youtube:([a-zA-Z0-9_-]{11})\}\}/);
  if (tag) return tag[1];
  return youtubeId(body);
}

/** 本文の中の「[マインドマップ](住所)」から住所だけを取り出す。無ければ null */
function mindmapUrlFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const m = body.match(/\[マインドマップ\]\(([^)]+)\)/);
  return m ? m[1].trim() : null;
}

/** 題名の文字（コードポイント）の数 */
function titleLength(title: string): number {
  return [...title].length;
}

/**
 * 文字列の要約値（FNV-1a・32 ビット・10 進で返す）。
 * UTF-8 の並びに対して計算する。1 文字でも違えば必ず別の数になるので、
 * 題名を書き写さずに、数どうしで突き合わせるために使う。
 */
function fnv1a(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 日付（2024-01-10）を並び順の数（20240110）にする。
 * この数は日付そのものなので、鍵が date のときは見分けにも使う。
 * 読めない形なら 0 を返さず、はっきり止める。
 */
function dateKey(date: string): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`日付の形が違います（${date}）。2024-01-10 の形で渡してください`);
  }
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

interface SeminarRow {
  date: string;
  title: string;
  summary?: string;
  tags?: string;
  video_url?: string;
  mindmap_url?: string;
  slide_url?: string;
  order_index?: number;
}

/** 説明の欄。日付を先頭に置き、題名とは別の行に出るようにする */
function buildDescription(row: SeminarRow): string {
  const head = `${row.date} ｜ `;
  const body = (row.summary ?? "").trim();
  return (head + body).slice(0, DESC_MAX);
}

/** 本文を組み立てる。日付は先頭に置く。呼び名は渡されたものを使う */
function buildBody(row: SeminarRow, dateLabel: string): string {
  const parts: string[] = [];

  parts.push(`${dateLabel}：${row.date}`);

  const vid = youtubeId(row.video_url);
  if (vid) {
    parts.push(`{{youtube:${vid}}}`);
  } else if (row.video_url && row.video_url.trim()) {
    parts.push(`{{linkcard:${row.video_url.trim()}|動画||}}`);
  }

  if (row.summary && row.summary.trim()) {
    parts.push(`## 概要\n${row.summary.trim()}`);
  }

  const links: string[] = [];
  if (row.mindmap_url && row.mindmap_url.trim()) {
    links.push(`[マインドマップ](${row.mindmap_url.trim()})`);
  }
  if (row.slide_url && row.slide_url.trim()) {
    links.push(`[スライド](${row.slide_url.trim()})`);
  }
  if (row.video_url && row.video_url.trim()) {
    links.push(`[YouTube で開く](${row.video_url.trim()})`);
  }
  if (links.length > 0) {
    parts.push(`{{linkset_inline}}\n${links.join("\n")}\n{{/linkset_inline}}`);
  }

  if (row.tags && row.tags.trim()) {
    parts.push("---");
    parts.push(`タグ：${row.tags.trim()}`);
  }

  return parts.join("\n\n");
}

export function registerManabuSeminarTools(server: McpServer, env: Env): void {
  // ─────────────────────────────────────────────
  // 読むだけ。表の欄と、今ある棚を返す
  // ─────────────────────────────────────────────
  server.tool(
    "mn__peek",
    "学ぶくんの表の欄と、今ある棚（カリキュラム・プログラム・コース）の一覧を返す。書き込みは一切しない。mn__put_seminar を使う前に、書き込む先の欄が実在するかを確かめるために使う。",
    {
      include_columns: z
        .boolean()
        .optional()
        .describe("true で表の欄の名前も返す（既定 true）"),
    },
    async ({ include_columns }) => {
      const result: Record<string, unknown> = {};

      // 表の欄はデータベース側の定義から読む（決め打ちしない）
      if (include_columns !== false) {
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, {
          headers: { ...sbHeaders(env), Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`定義を取得できませんでした（${res.status}）`);
        }
        const spec = (await res.json()) as {
          definitions?: Record<string, { properties?: Record<string, unknown> }>;
        };
        const defs = spec.definitions ?? {};
        const mnTables = Object.keys(defs)
          .filter((n) => n.slice(0, 3) === "mn_")
          .sort();
        result["mn_で始まる表"] = mnTables;
        const columns: Record<string, string[]> = {};
        for (const t of [T_CONTENTS, T_COURSES, T_PROGRAMS, T_CURRICULUMS, T_CURRICULUM_PROGRAMS]) {
          columns[t] = Object.keys(defs[t]?.properties ?? {}).sort();
        }
        result["欄"] = columns;
      }

      result["カリキュラム"] = await sbGet(
        env,
        `${T_CURRICULUMS}?select=id,user_id,title,slug,active,order_index&order=order_index`
      );
      result["プログラム"] = await sbGet(
        env,
        `${T_PROGRAMS}?select=id,user_id,title,active,order_index&order=order_index`
      );
      result["コース"] = await sbGet(
        env,
        `${T_COURSES}?select=id,user_id,program_id,title,active,order_index&order=order_index`
      );
      result["カリキュラムとプログラムの結び"] = await sbGet(
        env,
        `${T_CURRICULUM_PROGRAMS}?select=curriculum_id,program_id,order_index`
      );
      const contents = await sbGetAll(
        env,
        `${T_CONTENTS}?select=id,course_id,title,active,order_index&order=order_index`
      );
      result["コンテンツの件数"] = contents.length;
      const 生きている = new Set(
        contents.filter((c) => c.active !== false).map((c) => String(c.id))
      );
      const { map: 所属, linkRows } = await courseMembership(env, contents);
      const byCourse: Record<string, number> = {};
      for (const [courseId, ids] of 所属) {
        let n = 0;
        for (const id of ids) if (生きている.has(id)) n += 1;
        byCourse[courseId] = n;
      }
      result["棚ごとの件数"] = byCourse;
      result["所属の表の行数"] = linkRows;

      // 学ぶ人（ログインと結びついている会員だけ）。名前も連絡先も返さない
      const members = await sbGet(env, `shr_members?select=id,user_id`);
      const loginable = members.filter((m) => m.user_id);
      result["会員の数"] = { 全体: members.length, ログインと結びついている人: loginable.length };
      result["ログインと結びついている人の番号"] = loginable.map((m) => m.id);
      result["会員とカリキュラムの結び"] = await sbGet(
        env,
        `${T_MEMBER_CURRICULUMS}?select=id,member_id,curriculum_id,active`
      );

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // B：今の棚が持っている動画の番号を返す（読むだけ）
  // ─────────────────────────────────────────────
  server.tool(
    "mn__video_urls",
    "学ぶくんに今入っている行が持っている動画の番号を返す（読むだけ・書き込みは一切しない）。YouTube の全件からこの一覧を引くと、まだ入れていない動画が機械で確定できる。同じ動画を 2 つ以上の行が指している場合はその組も返す。",
    {
      course_titles: z
        .array(z.string())
        .optional()
        .describe("この名前のコースだけに絞る。省略すると全部の棚を見る"),
      include_list: z
        .boolean()
        .optional()
        .describe("true で動画の番号を全部並べて返す（既定 true）"),
    },
    async ({ course_titles, include_list }) => {
      const courses = await sbGet(
        env,
        `${T_COURSES}?select=id,title,program_id,order_index&order=order_index`
      );
      const target = course_titles
        ? courses.filter((c) => course_titles.includes(c.title))
        : courses;

      // 名前で絞ったのに 1 つも当たらなければ、0 件を答えにしないで止める
      if (course_titles && target.length === 0) {
        throw new Error(
          `その名前のコースがありません（${course_titles.join(
            ", "
          )}）。今ある名前：${courses.map((c) => c.title).join(", ")}`
        );
      }

      const contents = await sbGet(
        env,
        `${T_CONTENTS}?select=id,course_id,title,order_index,body_markdown&order=order_index`
      );

      const 棚ごと: Record<string, { 件数: number; 動画あり: number; 動画なし: number }> = {};
      const idToRows: Record<string, string[]> = {};
      const 動画なしの題名: string[] = [];

      for (const c of target) {
        const rows = contents.filter((ct) => ct.course_id === c.id);
        let withVideo = 0;
        for (const r of rows) {
          const vid = videoIdFromBody(r.body_markdown);
          if (vid) {
            withVideo += 1;
            (idToRows[vid] ??= []).push(`${c.title} ${r.title}`);
          } else {
            動画なしの題名.push(`${c.title} ${r.title}`);
          }
        }
        棚ごと[c.title] = {
          件数: rows.length,
          動画あり: withVideo,
          動画なし: rows.length - withVideo,
        };
      }

      const ids = Object.keys(idToRows).sort();
      const 重なり = ids
        .filter((v) => idToRows[v].length > 1)
        .map((v) => ({ 動画の番号: v, 指している行: idToRows[v] }));

      const result: Record<string, unknown> = {
        見た棚: target.map((c) => c.title),
        見た行の合計: target.reduce((m, c) => m + (棚ごと[c.title]?.件数 ?? 0), 0),
        動画を持っている行: Object.values(棚ごと).reduce((m, v) => m + v.動画あり, 0),
        別々の動画の番号の数: ids.length,
        棚ごと: 棚ごと,
        同じ動画を指している組: 重なり,
        動画を持っていない行の題名: 動画なしの題名,
      };
      if (include_list !== false) {
        result["動画の番号の一覧"] = ids;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // C：本文と説明の中の「\#」を「#」に直す
  // ─────────────────────────────────────────────
  server.tool(
    "mn__fix_backslash",
    "学ぶくんに入っている行の題名・説明・本文の中の「\\#」を「#」に直す。原稿を文章の形で取り出すと「#」の前に逆斜線が付くため、その残りを落とす。直す対象はこの 2 文字だけで、他の逆斜線には触らない。dry_run=true で書かずに、何件当たるかだけを返す。",
    {
      course_titles: z
        .array(z.string())
        .min(1)
        .describe("直す対象のコースの名前（例：2023年）。名前が 1 つも当たらなければ止まる"),
      dry_run: z.boolean().optional().describe("true で書かずに、当たる件数と題名だけ返す"),
    },
    async ({ course_titles, dry_run }) => {
      const courses = await sbGet(env, `${T_COURSES}?select=id,title&order=order_index`);
      const target = courses.filter((c) => course_titles.includes(c.title));

      // 名前が当たらないまま 0 件を返さない。当たらない名前があれば全部書いて止める
      const missing = course_titles.filter((t) => !courses.some((c) => c.title === t));
      if (missing.length > 0) {
        throw new Error(
          `その名前のコースがありません（${missing.join(", ")}）。今ある名前：${courses
            .map((c) => c.title)
            .join(", ")}`
        );
      }

      const contents = await sbGet(
        env,
        `${T_CONTENTS}?select=id,course_id,title,description,body_markdown,order_index&order=order_index`
      );

      const 当たった: { コース: string; 題名: string; 場所: string[] }[] = [];
      const 棚ごと: Record<string, { 見た件数: number; 当たった件数: number }> = {};

      for (const c of target) {
        const rows = contents.filter((ct) => ct.course_id === c.id);
        let hitCount = 0;

        for (const r of rows) {
          const 場所: string[] = [];
          const next: Record<string, unknown> = {};

          for (const field of ["title", "description", "body_markdown"] as const) {
            const before = (r as any)[field] as string | null | undefined;
            if (typeof before === "string" && before.includes(BACKSLASH_HASH)) {
              場所.push(field);
              next[field] = before.split(BACKSLASH_HASH).join("#");
            }
          }

          if (場所.length === 0) continue;
          hitCount += 1;
          当たった.push({ コース: c.title, 題名: r.title, 場所: 場所 });

          if (!dry_run) {
            await sbUpdateById(env, T_CONTENTS, r.id, {
              ...next,
              updated_at: new Date().toISOString(),
            });
          }
        }

        棚ごと[c.title] = { 見た件数: rows.length, 当たった件数: hitCount };
      }

      // 書いたあとに取り直して、残っていないことを確かめる
      let 直したあとに残っている件数: number | string = "調べていない（試しのため）";
      if (!dry_run) {
        const after = await sbGet(
          env,
          `${T_CONTENTS}?select=id,course_id,title,description,body_markdown`
        );
        const targetIds = target.map((c) => c.id);
        直したあとに残っている件数 = after.filter(
          (r) =>
            targetIds.includes(r.course_id) &&
            [r.title, r.description, r.body_markdown].some(
              (v) => typeof v === "string" && v.includes(BACKSLASH_HASH)
            )
        ).length;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                書いたかどうか: dry_run ? "書いていない（試し）" : "書いた",
                見た棚: target.map((c) => c.title),
                棚ごと: 棚ごと,
                当たった行の合計: 当たった.length,
                直したあとに残っている件数: 直したあとに残っている件数,
                当たった行: 当たった,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // A：セミナーの一覧を学ぶくんに入れる
  // ─────────────────────────────────────────────
  server.tool(
    "mn__put_seminar",
    "セミナーの一覧の行を学ぶくんに入れる（1 回に最大 50 本）。棚（コース）が無ければ作る。棚は year（2024 と渡すと「2024年」）か course_title（名前をそのまま）のどちらか一方で指定する。同じ行かどうかの鍵は match_by で選ぶ：date（既定・同じ棚に同じ日付の行があれば書き換える）か video_url（同じ動画を指す行があれば書き換える）。★ video_url を鍵にするのは原稿に無い動画を入れるときだけにすること。年の棚の 142 行には同じ動画を指す行が 1 組あり、この鍵で流し直すと 1 本に潰れる（統括の判定 12・2026-08-24）。dry_run=true にすると書かずに組み立てた中身だけを返す。",
    {
      year: z
        .string()
        .optional()
        .describe("年の棚の名前に使う 4 桁（例：2024）。棚の名前は「2024年」になる"),
      course_title: z
        .string()
        .optional()
        .describe("棚の名前をそのまま指定する（例：その他のアーカイブ）。year とは同時に使えない"),
      course_order_index: z
        .number()
        .optional()
        .describe("棚を新しく作るときの並び順。省略すると year の数、course_title のときは末尾"),
      course_description: z.string().optional().describe("棚を新しく作るときの説明"),
      match_by: z
        .enum(["date", "video_url"])
        .optional()
        .describe("同じ行かどうかの鍵（既定 date）。video_url は原稿に無い動画を入れるときだけ"),
      date_label: z
        .string()
        .optional()
        .describe("本文の先頭に置く日付の呼び名（既定：開催日）。公開日を入れるときは 公開日 と渡す"),
      rows: z
        .array(
          z.object({
            date: z.string().describe("日付（2024-01-10 の形）"),
            title: z.string().describe("セミナーの題名（日付は入れない）"),
            summary: z.string().optional().describe("概要の文章。原稿のものをそのまま"),
            tags: z.string().optional().describe("タグの行をそのまま（整形しない）"),
            video_url: z.string().optional().describe("動画の住所"),
            mindmap_url: z.string().optional().describe("マインドマップの住所"),
            slide_url: z.string().optional().describe("スライドの住所"),
            order_index: z
              .number()
              .optional()
              .describe("並び順。省略すると日付の数（20240110）になる"),
          })
        )
        .min(1)
        .max(MAX_ROWS)
        .describe("入れる行。1 回に最大 50 本"),
      program_title: z
        .string()
        .optional()
        .describe("棚を束ねるプログラムの名前（既定：しあらぼセミナーアーカイブ）"),
      user_id: z
        .string()
        .optional()
        .describe("持ち主。省略すると今あるプログラムから読み取る（1 種類でなければ止まる）"),
      dry_run: z.boolean().optional().describe("true で書かずに中身だけ返す"),
    },
    async ({
      year,
      course_title,
      course_order_index,
      course_description,
      match_by,
      date_label,
      rows,
      program_title,
      user_id,
      dry_run,
    }) => {
      const programTitle = program_title ?? "しあらぼセミナーアーカイブ";
      const matchBy = match_by ?? "date";
      const dateLabel = date_label ?? "開催日";

      // 棚の指定は year か course_title のどちらか一方。両方でも両方無しでも止める
      if ((year && course_title) || (!year && !course_title)) {
        throw new Error(
          "棚の指定は year か course_title のどちらか一方にしてください（両方または両方無しは受け付けません）"
        );
      }
      const courseTitle = course_title ?? `${year}年`;

      // 先に全部組み立てる。日付の形が悪い行があれば、1 行も書かずにここで止まる
      const built = rows.map((r) => {
        const row = r as SeminarRow;
        const dk = dateKey(row.date);
        return {
          row,
          dateKey: dk,
          orderIndex: typeof row.order_index === "number" ? row.order_index : dk,
          videoId: youtubeId(row.video_url),
          description: buildDescription(row),
          body: buildBody(row, dateLabel),
        };
      });

      // 鍵が重なっていると、あとの行が前の行を消してしまう。書く前に止める
      if (matchBy === "date") {
        const keys = built.map((b) => b.dateKey);
        const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
        if (dup.length > 0) {
          throw new Error(
            `同じ日付の行が渡されています（${Array.from(new Set(dup)).join(
              ", "
            )}）。鍵が date のときは 1 回の呼び出しで日付が重ならないようにしてください`
          );
        }
      } else {
        const noVideo = built.filter((b) => !b.videoId).map((b) => b.row.title);
        if (noVideo.length > 0) {
          throw new Error(
            `鍵が video_url なのに動画の住所が読めない行があります（${noVideo.join(
              " / "
            )}）。全部の行に YouTube の住所を入れてください`
          );
        }
        const vids = built.map((b) => b.videoId as string);
        const dup = vids.filter((v, i) => vids.indexOf(v) !== i);
        if (dup.length > 0) {
          throw new Error(
            `同じ動画を指す行が渡されています（${Array.from(new Set(dup)).join(
              ", "
            )}）。1 回の呼び出しで動画が重ならないようにしてください`
          );
        }
      }

      if (dry_run) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  試しに組み立てただけ: true,
                  プログラム: programTitle,
                  コース: courseTitle,
                  鍵: matchBy,
                  日付の呼び名: dateLabel,
                  本数: built.length,
                  中身: built.map((b) => ({
                    題名: b.row.title,
                    説明: b.description,
                    並び順: b.orderIndex,
                    動画の番号: b.videoId,
                    本文: b.body,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // 持ち主を決める
      const programs = await sbGet(
        env,
        `${T_PROGRAMS}?select=id,user_id,title,order_index&order=order_index`
      );
      let owner = user_id;
      if (!owner) {
        const owners = Array.from(new Set(programs.map((p) => p.user_id).filter(Boolean)));
        if (owners.length !== 1) {
          throw new Error(
            `持ち主を決められませんでした（今あるプログラムの持ち主が ${owners.length} 種類）。user_id を指定してください`
          );
        }
        owner = owners[0] as string;
      }

      // プログラムを探す。無ければ作る
      let program = programs.find((p) => p.title === programTitle && p.user_id === owner);
      let programCreated = false;
      if (!program) {
        const maxOrder = programs.reduce(
          (m, p) => (typeof p.order_index === "number" && p.order_index > m ? p.order_index : m),
          -1
        );
        program = await sbInsert(env, T_PROGRAMS, {
          user_id: owner,
          title: programTitle,
          description: "しあらぼのセミナーアーカイブ。年ごとの棚に分けてある",
          order_index: maxOrder + 1,
        });
        programCreated = true;
      }

      // 棚（コース）を探す。無ければ作る
      const courses = await sbGet(
        env,
        `${T_COURSES}?select=id,user_id,program_id,title,order_index&program_id=eq.${encodeURIComponent(
          program.id
        )}`
      );
      let course = courses.find((c) => c.title === courseTitle);
      let courseCreated = false;
      if (!course) {
        const maxCourseOrder = courses.reduce(
          (m, c) => (typeof c.order_index === "number" && c.order_index > m ? c.order_index : m),
          -1
        );
        const order =
          typeof course_order_index === "number"
            ? course_order_index
            : year
            ? Number(year)
            : maxCourseOrder + 1;
        course = await sbInsert(env, T_COURSES, {
          user_id: owner,
          program_id: program.id,
          title: courseTitle,
          description: course_description ?? (year ? `${year} 年のセミナー` : courseTitle),
          order_index: order,
        });
        courseCreated = true;
      }

      // 棚の中の今の行を一度だけ取る。鍵が video_url のときは本文も取る
      const select =
        matchBy === "video_url"
          ? "id,title,order_index,body_markdown"
          : "id,title,order_index";
      const existing = await sbGet(
        env,
        `${T_CONTENTS}?select=${select}&course_id=eq.${encodeURIComponent(course.id)}`
      );
      const existingVideo: Record<string, any> = {};
      if (matchBy === "video_url") {
        for (const e of existing) {
          const v = videoIdFromBody(e.body_markdown);
          if (v && !existingVideo[v]) existingVideo[v] = e;
        }
      }

      const 足した: string[] = [];
      const 書き換えた: string[] = [];

      for (const b of built) {
        const hit =
          matchBy === "video_url"
            ? existingVideo[b.videoId as string]
            : existing.find((c) => c.order_index === b.dateKey);
        const payload = {
          user_id: owner,
          course_id: course.id,
          title: b.row.title,
          description: b.description,
          content_type: "rich",
          body_markdown: b.body,
          linkset_data: null,
          order_index: b.orderIndex,
          active: true,
        };
        if (hit) {
          await sbUpdateById(env, T_CONTENTS, hit.id, {
            ...payload,
            updated_at: new Date().toISOString(),
          });
          await sbLinkContentToCourse(env, hit.id, course.id, b.orderIndex);
          書き換えた.push(`${b.row.date} ${b.row.title}`);
        } else {
          const 入れた行 = await sbInsert(env, T_CONTENTS, payload);
          await sbLinkContentToCourse(env, 入れた行.id, course.id, b.orderIndex);
          足した.push(`${b.row.date} ${b.row.title}`);
        }
      }

      // 書いたあとに取り直して数える
      const after = await sbGet(
        env,
        `${T_CONTENTS}?select=id&course_id=eq.${encodeURIComponent(course.id)}`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                プログラム: { id: program.id, title: programTitle, 新しく作った: programCreated },
                コース: { id: course.id, title: courseTitle, 新しく作った: courseCreated },
                鍵: matchBy,
                渡された本数: built.length,
                足した本数: 足した.length,
                書き換えた本数: 書き換えた.length,
                この棚の今の件数: after.length,
                足した: 足した,
                書き換えた: 書き換えた,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // カリキュラムを作り、プログラムと学ぶ人を結ぶ
  // ─────────────────────────────────────────────
  server.tool(
    "mn__put_curriculum",
    "カリキュラムを作り、プログラムと学ぶ人を結ぶ。カリキュラムが既にあれば作らずにそれを使う。結び直しても二重にならない。move_from があれば、その名前のカリキュラムから同じ人の結びを外してから付け替える。dry_run=true で何もせずに予定だけ返す。",
    {
      title: z.string().describe("カリキュラムの名前（例：しあらぼ）"),
      slug: z
        .string()
        .optional()
        .describe("住所に使う英小文字・数字・ハイフン（3〜50 文字）。省略すると設定しない"),
      program_titles: z
        .array(z.string())
        .optional()
        .describe("このカリキュラムに結ぶプログラムの名前。既に結ばれていれば何もしない"),
      member_ids: z
        .array(z.string())
        .optional()
        .describe("結ぶ学ぶ人の番号。mn__peek の「ログインと結びついている人の番号」から渡す"),
      move_from: z
        .string()
        .optional()
        .describe("この名前のカリキュラムに同じ人の結びがあれば外す（付け替え）"),
      user_id: z.string().optional().describe("持ち主。省略すると今あるカリキュラムまたはプログラムから読み取る"),
      dry_run: z.boolean().optional().describe("true で何もせずに予定だけ返す"),
    },
    async ({ title, slug, program_titles, member_ids, move_from, user_id, dry_run }) => {
      const curriculums = await sbGet(
        env,
        `${T_CURRICULUMS}?select=id,user_id,title,slug,order_index&order=order_index`
      );
      const programs = await sbGet(env, `${T_PROGRAMS}?select=id,user_id,title`);

      let owner = user_id;
      if (!owner) {
        const owners = Array.from(
          new Set([...curriculums, ...programs].map((r) => r.user_id).filter(Boolean))
        );
        if (owners.length !== 1) {
          throw new Error(
            `持ち主を決められませんでした（${owners.length} 種類）。user_id を指定してください`
          );
        }
        owner = owners[0] as string;
      }

      // 結ぶ相手のプログラムを先に全部見つける。1 つでも見つからなければ何もせず止める
      const targetPrograms = (program_titles ?? []).map((t) => {
        const p = programs.find((x) => x.title === t && x.user_id === owner);
        if (!p) throw new Error(`プログラムが見つかりません（${t}）。名前をそのまま渡してください`);
        return p;
      });

      const 予定: Record<string, unknown> = {
        カリキュラム: title,
        結ぶプログラム: targetPrograms.map((p) => p.title),
        結ぶ人の数: (member_ids ?? []).length,
        外す元: move_from ?? "なし",
      };
      if (dry_run) {
        return { content: [{ type: "text", text: JSON.stringify({ 予定, したこと: "なし（試し）" }, null, 2) }] };
      }

      // カリキュラム
      let curriculum = curriculums.find((c) => c.title === title && c.user_id === owner);
      let curriculumCreated = false;
      if (!curriculum) {
        const maxOrder = curriculums.reduce(
          (m, c) => (typeof c.order_index === "number" && c.order_index > m ? c.order_index : m),
          -1
        );
        const row: Record<string, unknown> = {
          user_id: owner,
          title,
          description: "",
          order_index: maxOrder + 1,
        };
        if (slug) row.slug = slug;
        curriculum = await sbInsert(env, T_CURRICULUMS, row);
        curriculumCreated = true;
      }

      // プログラムを結ぶ
      const links = await sbGet(
        env,
        `${T_CURRICULUM_PROGRAMS}?select=curriculum_id,program_id,order_index&curriculum_id=eq.${encodeURIComponent(
          curriculum.id
        )}`
      );
      const 結んだプログラム: string[] = [];
      let order = links.reduce(
        (m, l) => (typeof l.order_index === "number" && l.order_index > m ? l.order_index : m),
        -1
      );
      for (const p of targetPrograms) {
        if (links.some((l) => l.program_id === p.id)) continue;
        order += 1;
        await sbInsert(env, T_CURRICULUM_PROGRAMS, {
          curriculum_id: curriculum.id,
          program_id: p.id,
          order_index: order,
        });
        結んだプログラム.push(p.title);
      }

      // 学ぶ人を結ぶ
      const 結んだ人: string[] = [];
      const 外した人: string[] = [];
      if (member_ids && member_ids.length > 0) {
        const all = await sbGet(
          env,
          `${T_MEMBER_CURRICULUMS}?select=id,member_id,curriculum_id,active`
        );
        const from = move_from
          ? curriculums.find((c) => c.title === move_from && c.user_id === owner)
          : null;

        for (const mid of member_ids) {
          const hit = all.find((r) => r.member_id === mid && r.curriculum_id === curriculum.id);
          if (hit) {
            if (hit.active !== true) {
              await sbUpdateById(env, T_MEMBER_CURRICULUMS, hit.id, { active: true });
              結んだ人.push(mid);
            }
          } else {
            await sbInsert(env, T_MEMBER_CURRICULUMS, {
              user_id: owner,
              member_id: mid,
              curriculum_id: curriculum.id,
            });
            結んだ人.push(mid);
          }

          if (from) {
            const old = all.find(
              (r) => r.member_id === mid && r.curriculum_id === from.id && r.active === true
            );
            if (old) {
              await sbUpdateById(env, T_MEMBER_CURRICULUMS, old.id, { active: false });
              外した人.push(mid);
            }
          }
        }
      }

      // 書いたあとに取り直す
      const after = await sbGet(
        env,
        `${T_MEMBER_CURRICULUMS}?select=id&curriculum_id=eq.${encodeURIComponent(
          curriculum.id
        )}&active=is.true`
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                カリキュラム: { id: curriculum.id, title, 新しく作った: curriculumCreated },
                結んだプログラム: 結んだプログラム,
                結んだ人の数: 結んだ人.length,
                外した人の数: 外した人.length,
                このカリキュラムに結ばれている人の数: after.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────
  // 学ぶ人の画面に何が出るかを、画面と同じ道すじで確かめる
  // ─────────────────────────────────────────────
  server.tool(
    "mn__learner_view",
    "指定した学ぶ人の画面に何が出るかを返す。画面と同じ道すじ（結ばれているカリキュラム → プログラム → 公開中のコース → 公開中のコンテンツ）をたどるので、画面を開かずに出る・出ないを判定できる。コースの中身は所属の表 mn_content_courses と mn_contents.course_id の両方から引き、同じ組み合わせは 1 回だけ数える。書き込みは一切しない。",
    {
      member_id: z.string().describe("学ぶ人の番号（mn__peek で取れる）"),
      course_title: z
        .string()
        .optional()
        .describe("この名前のコースの中身も 1 件目から数件だけ返す（例：2024年）"),
    },
    async ({ member_id, course_title }) => {
      const mc = await sbGet(
        env,
        `${T_MEMBER_CURRICULUMS}?select=curriculum_id&member_id=eq.${encodeURIComponent(
          member_id
        )}&active=is.true`
      );
      const curriculumIds = mc.map((r) => r.curriculum_id);
      if (curriculumIds.length === 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ 見えるもの: "なし（カリキュラムに結ばれていない）" }, null, 2) },
          ],
        };
      }

      const allCurriculums = await sbGet(env, `${T_CURRICULUMS}?select=id,title,active`);
      const links = await sbGet(env, `${T_CURRICULUM_PROGRAMS}?select=curriculum_id,program_id`);
      const programIds = links
        .filter((l) => curriculumIds.includes(l.curriculum_id))
        .map((l) => l.program_id);
      const allPrograms = await sbGet(env, `${T_PROGRAMS}?select=id,title,active`);
      const courses = await sbGet(
        env,
        `${T_COURSES}?select=id,program_id,title,active,order_index&order=order_index`
      );
      const contents = await sbGetAll(
        env,
        `${T_CONTENTS}?select=id,course_id,title,active,order_index&order=order_index`
      );
      const { map: 所属, linkRows } = await courseMembership(env, contents);
      const 生きている = new Map(
        contents.filter((ct) => ct.active !== false).map((ct) => [String(ct.id), ct])
      );
      const 棚の中身 = (courseId: string) =>
        [...(所属.get(String(courseId)) ?? [])]
          .map((id) => 生きている.get(id))
          .filter((ct): ct is any => Boolean(ct))
          .sort(
            (a, b) =>
              (a.order_index ?? 0) - (b.order_index ?? 0) ||
              String(a.id).localeCompare(String(b.id))
          );

      const 見えるコース = courses
        .filter((c) => programIds.includes(c.program_id) && c.active !== false)
        .map((c) => ({
          コース: c.title,
          件数: 棚の中身(c.id).length,
        }));

      const result: Record<string, unknown> = {
        結ばれているカリキュラム: allCurriculums
          .filter((c) => curriculumIds.includes(c.id))
          .map((c) => c.title),
        見えるプログラム: allPrograms
          .filter((p) => programIds.includes(p.id) && p.active !== false)
          .map((p) => p.title),
        見えるコース: 見えるコース,
      };

      if (course_title) {
        const target = courses.find(
          (c) => c.title === course_title && programIds.includes(c.program_id)
        );
        if (!target) {
          result[`${course_title} の中身`] = "この人には見えない";
        } else {
          const list = 棚の中身(target.id).map((ct) => ct.title);
          result[`${course_title} の中身`] = { 件数: list.length, 先頭の3本: list.slice(0, 3) };
        }
      }

      // 所属の表を読めているかを、この返りの中で確かめられるようにしておく
      result["所属の表の行数"] = linkRows;

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // D：棚の中の題名と、その指紋を返す（読むだけ）
  //
  // なぜ指紋を一緒に返すか：
  //   返ってきた題名を元の原稿と突き合わせるには、いま応答へ書き写す工程が要る。
  //   その二度目の書き写しで無意識に直してしまうと、差 0 件と出て誤りが隠れる。
  //   文字ではなく数（文字数の合計・要約値）で比べれば、1 文字違えば必ずずれる。
  // ─────────────────────────────────────────────
  server.tool(
    "mn__titles",
    "学ぶくんの棚に入っている行の題名を全数で返す（読むだけ・書き込みは一切しない）。題名そのものに加えて、1 行ごとと棚ごとの指紋（題名の文字数と要約値）を返す。入れたあとに、元の原稿から同じ指紋を機械で出して数どうしを比べれば、題名の取り違えを目に頼らず見つけられる。マインドマップの住所も一緒に返すので、まだ入れていないマインドマップの本数も機械で確定できる。",
    {
      course_titles: z
        .array(z.string())
        .optional()
        .describe("この名前のコースだけに絞る。省略すると全部の棚を見る"),
      include_list: z
        .boolean()
        .optional()
        .describe("true で 1 行ごとの中身を全部並べて返す（既定 true）。false にすると棚ごとの数だけ返る"),
    },
    async ({ course_titles, include_list }) => {
      const courses = await sbGet(
        env,
        `${T_COURSES}?select=id,title,program_id,order_index&order=order_index`
      );
      const target = course_titles
        ? courses.filter((c) => course_titles.includes(c.title))
        : courses;

      // 名前で絞ったのに 1 つも当たらなければ、0 件を答えにしないで止める
      if (course_titles && target.length === 0) {
        throw new Error(
          `その名前のコースがありません（${course_titles.join(
            ", "
          )}）。今ある名前：${courses.map((c) => c.title).join(", ")}`
        );
      }

      const contents = await sbGet(
        env,
        `${T_CONTENTS}?select=id,course_id,title,order_index,body_markdown&order=order_index`
      );

      const 棚ごと: Record<
        string,
        {
          件数: number;
          題名の文字数の合計: number;
          棚の指紋: number;
          マインドマップを持つ行: number;
          動画を持つ行: number;
        }
      > = {};
      const 一覧: Array<Record<string, unknown>> = [];

      for (const c of target) {
        const rows = contents
          .filter((ct) => ct.course_id === c.id)
          .sort(
            (a, b) =>
              (a.order_index ?? 0) - (b.order_index ?? 0) ||
              String(a.id).localeCompare(String(b.id))
          );

        let 文字数合計 = 0;
        let mmあり = 0;
        let 動画あり = 0;

        for (const r of rows) {
          const title = typeof r.title === "string" ? r.title : "";
          const mm = mindmapUrlFromBody(r.body_markdown);
          const vid = videoIdFromBody(r.body_markdown);
          文字数合計 += titleLength(title);
          if (mm) mmあり += 1;
          if (vid) 動画あり += 1;

          一覧.push({
            棚: c.title,
            並び順: r.order_index ?? null,
            動画の番号: vid,
            マインドマップの住所: mm,
            題名: title,
            題名の文字数: titleLength(title),
            題名の指紋: fnv1a(title),
          });
        }

        棚ごと[c.title] = {
          件数: rows.length,
          題名の文字数の合計: 文字数合計,
          棚の指紋: fnv1a(rows.map((r) => (typeof r.title === "string" ? r.title : "")).join("\n")),
          マインドマップを持つ行: mmあり,
          動画を持つ行: 動画あり,
        };
      }

      const result: Record<string, unknown> = {
        見た棚: target.map((c) => c.title),
        見た行の合計: 一覧.length,
        題名の文字数の合計: Object.values(棚ごと).reduce(
          (m, v) => m + v.題名の文字数の合計,
          0
        ),
        棚ごと: 棚ごと,
        指紋の作り方:
          "題名の文字数は文字（コードポイント）の数。指紋は題名の UTF-8 の並びに対する FNV-1a（32 ビット・10 進）。棚の指紋は、その棚の題名を並び順に改行でつないだ 1 本の文字列に対して同じ計算をしたもの",
      };
      if (include_list !== false) {
        result["一覧"] = 一覧;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
