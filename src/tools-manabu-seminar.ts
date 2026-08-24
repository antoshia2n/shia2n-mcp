/**
 * 学ぶくん：セミナーアーカイブを入れる道具（2026-08-24）
 * tools-manabu-seminar.ts
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
 *
 * 何回動かしても同じ結果になるようにしてある。同じコースの中に同じ題名が
 * あれば書き換え、無ければ足す。題名の先頭に日付を入れているので、
 * 同じ日の同じセミナーが二重に増えることはない。
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

/** 日付（2024-01-10）を並び順の数（20240110）にする。読めなければ 0 */
function orderFromDate(date: string): number {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

/** 本文を組み立てる */
function buildBody(args: {
  date: string;
  summary?: string;
  videoUrl?: string;
  mindmapUrl?: string;
  slideUrl?: string;
  tags?: string;
}): string {
  const parts: string[] = [];

  const vid = youtubeId(args.videoUrl);
  if (vid) {
    parts.push(`{{youtube:${vid}}}`);
  } else if (args.videoUrl) {
    parts.push(`{{linkcard:${args.videoUrl}|動画||}}`);
  }

  if (args.summary && args.summary.trim()) {
    parts.push(`## 概要\n${args.summary.trim()}`);
  }

  const links: string[] = [];
  if (args.mindmapUrl && args.mindmapUrl.trim()) {
    links.push(`[マインドマップ](${args.mindmapUrl.trim()})`);
  }
  if (args.slideUrl && args.slideUrl.trim()) {
    links.push(`[スライド](${args.slideUrl.trim()})`);
  }
  if (args.videoUrl && args.videoUrl.trim()) {
    links.push(`[YouTube で開く](${args.videoUrl.trim()})`);
  }
  if (links.length > 0) {
    parts.push(`{{linkset_inline}}\n${links.join("\n")}\n{{/linkset_inline}}`);
  }

  parts.push("---");
  parts.push(`開催日：${args.date}`);
  if (args.tags && args.tags.trim()) {
    parts.push(`タグ：${args.tags.trim()}`);
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
      const contents = await sbGet(env, `${T_CONTENTS}?select=id,course_id,title`);
      result["コンテンツの件数"] = contents.length;
      result["コンテンツの題名"] = contents.map((c) => c.title);

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─────────────────────────────────────────────
  // 一覧の 1 行を学ぶくんに入れる
  // ─────────────────────────────────────────────
  server.tool(
    "mn__put_seminar",
    "セミナーの一覧の 1 行を学ぶくんに入れる。年の棚（コース）が無ければ作る。同じ棚に同じ題名があれば書き換えるので、何回動かしても同じ結果になる。dry_run=true にすると書かずに組み立てた中身だけを返す。",
    {
      year: z.string().describe("年の棚の名前に使う 4 桁（例：2024）"),
      date: z.string().describe("開催日（2024-01-10 の形）"),
      title: z.string().describe("セミナーの題名（日付は含めない。こちらで先頭に付ける）"),
      summary: z.string().optional().describe("概要の文章。原稿のものをそのまま"),
      tags: z.string().optional().describe("タグの行をそのまま（整形しない）"),
      video_url: z.string().optional().describe("動画の住所"),
      mindmap_url: z.string().optional().describe("マインドマップの住所"),
      slide_url: z.string().optional().describe("スライドの住所"),
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
    async (args) => {
      const programTitle = args.program_title ?? "しあらぼセミナーアーカイブ";
      const courseTitle = `${args.year}年`;
      const contentTitle = `${args.date} ${args.title}`;

      const body = buildBody({
        date: args.date,
        summary: args.summary,
        videoUrl: args.video_url,
        mindmapUrl: args.mindmap_url,
        slideUrl: args.slide_url,
        tags: args.tags,
      });

      const description = (args.summary ?? "").trim().slice(0, 200);

      if (args.dry_run) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  試しに組み立てただけ: true,
                  プログラム: programTitle,
                  コース: courseTitle,
                  題名: contentTitle,
                  説明: description,
                  並び順: orderFromDate(args.date),
                  本文: body,
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
      let userId = args.user_id;
      if (!userId) {
        const owners = Array.from(new Set(programs.map((p) => p.user_id).filter(Boolean)));
        if (owners.length !== 1) {
          throw new Error(
            `持ち主を決められませんでした（今あるプログラムの持ち主が ${owners.length} 種類）。user_id を指定してください`
          );
        }
        userId = owners[0] as string;
      }

      // プログラムを探す。無ければ作る
      let program = programs.find((p) => p.title === programTitle && p.user_id === userId);
      let programCreated = false;
      if (!program) {
        const maxOrder = programs.reduce(
          (m, p) => (typeof p.order_index === "number" && p.order_index > m ? p.order_index : m),
          -1
        );
        program = await sbInsert(env, T_PROGRAMS, {
          user_id: userId,
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
          user_id: userId,
          program_id: program.id,
          title: courseTitle,
          description: `${args.year} 年のセミナー`,
          order_index: Number(args.year),
        });
        courseCreated = true;
      }

      // 同じ棚の中に同じ題名があるか
      const existing = await sbGet(
        env,
        `${T_CONTENTS}?select=id,title&course_id=eq.${encodeURIComponent(course.id)}`
      );
      const hit = existing.find((c) => c.title === contentTitle);

      const row = {
        user_id: userId,
        course_id: course.id,
        title: contentTitle,
        description,
        content_type: "rich",
        body_markdown: body,
        linkset_data: null,
        order_index: orderFromDate(args.date),
        active: true,
      };

      let content;
      let action;
      if (hit) {
        content = await sbUpdateById(env, T_CONTENTS, hit.id, {
          ...row,
          updated_at: new Date().toISOString(),
        });
        action = "書き換えた";
      } else {
        content = await sbInsert(env, T_CONTENTS, row);
        action = "足した";
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                したこと: action,
                プログラム: { id: program.id, title: programTitle, 新しく作った: programCreated },
                コース: { id: course.id, title: courseTitle, 新しく作った: courseCreated },
                コンテンツ: { id: content.id, title: content.title },
                本文の長さ: body.length,
                動画の番号: youtubeId(args.video_url),
                入れた住所の数: [args.video_url, args.mindmap_url, args.slide_url].filter(
                  (u) => u && u.trim()
                ).length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
