/**
 * 学ぶくん：セミナーアーカイブを入れる道具（2026-08-24）
 * tools-manabu-seminar.ts
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

/** 1 回の呼び出しで入れられる上限 */
const MAX_ROWS = 50;

/** 説明の欄に入れる長さの上限 */
const DESC_MAX = 200;

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
 * 日付（2024-01-10）を並び順の数（20240110）にする。
 * この数は日付そのものなので、同じものかどうかの見分けにも使う。
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
}

/** 説明の欄。日付を先頭に置き、題名とは別の行に出るようにする */
function buildDescription(row: SeminarRow): string {
  const head = `${row.date} ｜ `;
  const body = (row.summary ?? "").trim();
  return (head + body).slice(0, DESC_MAX);
}

/** 本文を組み立てる。日付は先頭に置く */
function buildBody(row: SeminarRow): string {
  const parts: string[] = [];

  parts.push(`開催日：${row.date}`);

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
      const contents = await sbGet(
        env,
        `${T_CONTENTS}?select=id,course_id,title,order_index&order=order_index`
      );
      result["コンテンツの件数"] = contents.length;
      const byCourse: Record<string, number> = {};
      for (const c of contents) {
        byCourse[c.course_id] = (byCourse[c.course_id] ?? 0) + 1;
      }
      result["棚ごとの件数"] = byCourse;

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
  // セミナーの一覧を学ぶくんに入れる
  // ─────────────────────────────────────────────
  server.tool(
    "mn__put_seminar",
    "セミナーの一覧の行を学ぶくんに入れる（1 回に最大 50 本）。年の棚（コース）が無ければ作る。同じ棚に同じ日付の行があれば書き換えるので、何回動かしても同じ結果になる。dry_run=true にすると書かずに組み立てた中身だけを返す。",
    {
      year: z.string().describe("年の棚の名前に使う 4 桁（例：2024）。行は全部この棚に入る"),
      rows: z
        .array(
          z.object({
            date: z.string().describe("開催日（2024-01-10 の形）"),
            title: z.string().describe("セミナーの題名（日付は入れない）"),
            summary: z.string().optional().describe("概要の文章。原稿のものをそのまま"),
            tags: z.string().optional().describe("タグの行をそのまま（整形しない）"),
            video_url: z.string().optional().describe("動画の住所"),
            mindmap_url: z.string().optional().describe("マインドマップの住所"),
            slide_url: z.string().optional().describe("スライドの住所"),
          })
        )
        .min(1)
        .max(MAX_ROWS)
        .describe("入れる行。1 回に最大 50 本"),
      program_title: z
        .string()
        .optional()
        .describe("年の棚を束ねるプログラムの名前（既定：しあらぼセミナーアーカイブ）"),
      user_id: z
        .string()
        .optional()
        .describe("持ち主。省略すると今あるプログラムから読み取る（1 種類でなければ止まる）"),
      dry_run: z.boolean().optional().describe("true で書かずに中身だけ返す"),
    },
    async ({ year, rows, program_title, user_id, dry_run }) => {
      const programTitle = program_title ?? "しあらぼセミナーアーカイブ";
      const courseTitle = `${year}年`;

      // 先に全部組み立てる。日付の形が悪い行があれば、1 行も書かずにここで止まる
      const built = rows.map((r) => ({
        row: r as SeminarRow,
        key: dateKey(r.date),
        description: buildDescription(r as SeminarRow),
        body: buildBody(r as SeminarRow),
      }));

      // 同じ日付が 2 行あると、あとの行が前の行を消してしまう。先に止める
      const keys = built.map((b) => b.key);
      const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
      if (dupKeys.length > 0) {
        throw new Error(
          `同じ日付の行が渡されています（${Array.from(new Set(dupKeys)).join(", ")}）。1 回の呼び出しでは日付が重ならないようにしてください`
        );
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
                  本数: built.length,
                  中身: built.map((b) => ({
                    題名: b.row.title,
                    説明: b.description,
                    並び順: b.key,
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

      // 年の棚（コース）を探す。無ければ作る
      const courses = await sbGet(
        env,
        `${T_COURSES}?select=id,user_id,program_id,title,order_index&program_id=eq.${encodeURIComponent(
          program.id
        )}`
      );
      let course = courses.find((c) => c.title === courseTitle);
      let courseCreated = false;
      if (!course) {
        course = await sbInsert(env, T_COURSES, {
          user_id: owner,
          program_id: program.id,
          title: courseTitle,
          description: `${year} 年のセミナー`,
          order_index: Number(year),
        });
        courseCreated = true;
      }

      // 棚の中の今の行を一度だけ取る（日付で見分ける）
      const existing = await sbGet(
        env,
        `${T_CONTENTS}?select=id,title,order_index&course_id=eq.${encodeURIComponent(course.id)}`
      );

      const 足した: string[] = [];
      const 書き換えた: string[] = [];

      for (const b of built) {
        const hit = existing.find((c) => c.order_index === b.key);
        const payload = {
          user_id: owner,
          course_id: course.id,
          title: b.row.title,
          description: b.description,
          content_type: "rich",
          body_markdown: b.body,
          linkset_data: null,
          order_index: b.key,
          active: true,
        };
        if (hit) {
          await sbUpdateById(env, T_CONTENTS, hit.id, {
            ...payload,
            updated_at: new Date().toISOString(),
          });
          書き換えた.push(`${b.row.date} ${b.row.title}`);
        } else {
          await sbInsert(env, T_CONTENTS, payload);
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
    "指定した学ぶ人の画面に何が出るかを返す。画面と同じ道すじ（結ばれているカリキュラム → プログラム → 公開中のコース → 公開中のコンテンツ）をたどるので、画面を開かずに出る・出ないを判定できる。書き込みは一切しない。",
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
      const contents = await sbGet(
        env,
        `${T_CONTENTS}?select=id,course_id,title,active,order_index&order=order_index`
      );

      const 見えるコース = courses
        .filter((c) => programIds.includes(c.program_id) && c.active !== false)
        .map((c) => ({
          コース: c.title,
          件数: contents.filter((ct) => ct.course_id === c.id && ct.active !== false).length,
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
          const list = contents
            .filter((ct) => ct.course_id === target.id && ct.active !== false)
            .map((ct) => ct.title);
          result[`${course_title} の中身`] = { 件数: list.length, 先頭の3本: list.slice(0, 3) };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
