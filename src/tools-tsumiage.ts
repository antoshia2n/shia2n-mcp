import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * 公式サイト「シアニンの積み上げラボ」（tsumiage-lab）の道具。
 * Supabase の tl_ で始まる表を直接見る（しあらぼの道具と同じ形）。
 *
 * 表：tl_contents（記事と動画）／tl_note_links（note のリンク）／tl_users（ログインした人）
 * 命名規約：tsumiage__<action>
 *
 * 2026-08-18 新設（段 1・公式サイト）。
 *   ・tl_users はこの道具から触らない。連絡先が入る表なので、書くのは画面の側の口だけ
 *   ・消す道具は作らない。status を archived にして画面から外す
 *   ・並べ替えの道具は作らない。公開日の新しい順で出す（依頼書の要件 7）
 *   ・この版では index.ts から呼んでいない。呼び出しを足すのは次の版
 */

type Row = Record<string, unknown>;

const CONTENT_TABLE = "tl_contents";
const NOTE_TABLE = "tl_note_links";

/** 書き換えを受け付けない列 */
const FORBIDDEN_COLUMNS = ["id", "user_id", "created_at", "updated_at"];

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbPost(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: sbHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: sbHeaders(env, { Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function registerTsumiageTools(server: McpServer, env: Env): void {

  // ─── 1. tsumiage__list_contents ──────────────────────────────────
  server.tool(
    "tsumiage__list_contents",
    "公式サイト（シアニンの積み上げラボ）に載せてある記事と動画の一覧を取る。下書きも含めて取れる。公開日の新しい順で返す。表にある列をそのまま返すため、列が増えても道具の側の直しは要らない。戻り値: { ok, total, contents: [行] }。",
    {
      status: z
        .enum(["draft", "published", "archived"])
        .optional()
        .describe("状態でしぼる。省略時は archived 以外を全部"),
      kind: z.enum(["article", "video"]).optional().describe("種類でしぼる。省略時は両方"),
      limit: z.number().int().min(1).max(200).optional().describe("最大件数（デフォルト 50）"),
    },
    async (args) => {
      const q: string[] = [
        "select=*",
        "order=published_at.desc.nullslast,created_at.desc",
        `limit=${args.limit ?? 50}`,
      ];
      if (args.status) q.push(`status=eq.${args.status}`);
      else q.push("status=neq.archived");
      if (args.kind) q.push(`kind=eq.${args.kind}`);
      const rows = await sbGet(env, `/${CONTENT_TABLE}?${q.join("&")}`);
      return asMcpTextResult({ ok: true, total: rows.length, contents: rows });
    }
  );

  // ─── 2. tsumiage__get_content ───────────────────────────────────
  server.tool(
    "tsumiage__get_content",
    "記事か動画 1 件を本文ごと取る。id か slug のどちらかを渡す（両方空は不可）。戻り値: { ok, content: 行 }。",
    {
      id: z.string().optional().describe("tl_contents の id"),
      slug: z.string().optional().describe("住所の一部になる文字列"),
    },
    async (args) => {
      if (!args.id && !args.slug) {
        return asMcpTextResult({ ok: false, error: "id か slug のどちらかを渡してください" });
      }
      const cond = args.id
        ? `id=eq.${encodeURIComponent(args.id)}`
        : `slug=eq.${encodeURIComponent(args.slug as string)}`;
      const rows = await sbGet(env, `/${CONTENT_TABLE}?select=*&${cond}&limit=1`);
      if (rows.length === 0) return asMcpTextResult({ ok: false, error: "見つかりません" });
      return asMcpTextResult({ ok: true, content: rows[0] });
    }
  );

  // ─── 3. tsumiage__add_content ───────────────────────────────────
  server.tool(
    "tsumiage__add_content",
    "公式サイトに記事か動画を 1 件足す。既定は下書き（draft）で、画面には出ない。公開するときは status に published を渡すか、あとで tsumiage__update_content で切り替える。slug が重なっていたら、上書きせずに止めて既存の行を返す。戻り値: { ok, content: 入った行 }。",
    {
      kind: z.enum(["article", "video"]).describe("article＝記事 / video＝動画"),
      slug: z.string().min(1).describe("住所の一部になる文字列。英小文字・数字・ハイフンだけ"),
      title: z.string().min(1).describe("見出し"),
      summary: z.string().optional().describe("一覧に出す短い説明"),
      body: z.string().optional().describe("本文（Markdown）"),
      video_url: z.string().optional().describe("動画の住所。kind が video のときは必須"),
      cover_url: z.string().optional().describe("一覧に出す画像の住所"),
      tags: z.array(z.string()).optional().describe("タグ。省略時は空"),
      level: z.number().int().min(1).max(3).optional().describe("階層（1＝無料）。省略時は 1"),
      status: z.enum(["draft", "published"]).optional().describe("省略時は draft"),
      published_at: z
        .string()
        .optional()
        .describe("公開日時（ISO 8601）。省略時、published なら今の時刻が入る"),
    },
    async (args) => {
      if (!/^[a-z0-9-]+$/.test(args.slug)) {
        return asMcpTextResult({
          ok: false,
          error: "slug は英小文字・数字・ハイフンだけにしてください",
          slug: args.slug,
        });
      }
      if (args.kind === "video" && !args.video_url) {
        return asMcpTextResult({ ok: false, error: "kind が video のときは video_url が要ります" });
      }
      const existing = await sbGet(
        env,
        `/${CONTENT_TABLE}?select=id,slug,title,status&slug=eq.${encodeURIComponent(args.slug)}&limit=1`
      );
      if (existing.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: "同じ slug がすでにあります。上書きせずに止めました",
          existing: existing[0],
        });
      }
      const status = args.status ?? "draft";
      const row: Row = {
        user_id: env.MCP_DEFAULT_USER_ID,
        kind: args.kind,
        slug: args.slug,
        title: args.title,
        summary: args.summary ?? null,
        body: args.body ?? null,
        video_url: args.video_url ?? null,
        cover_url: args.cover_url ?? null,
        tags: args.tags ?? [],
        level: args.level ?? 1,
        status,
        published_at: args.published_at ?? (status === "published" ? nowIso() : null),
        updated_at: nowIso(),
      };
      const inserted = await sbPost(env, `/${CONTENT_TABLE}`, row);
      return asMcpTextResult({ ok: inserted.length === 1, content: inserted[0] ?? null });
    }
  );

  // ─── 4. tsumiage__update_content ───────────────────────────────
  server.tool(
    "tsumiage__update_content",
    "記事か動画 1 件の欄を書き換える。1 回の呼び出しで 1 件だけ。updates に渡した欄だけが変わり、渡さなかった欄は元の値のまま残る。id・user_id・作られた日時は書き換えられない。preview=true のときは書かずに前後の値だけを返す。書いたあとは必ず取り直した結果を返す。戻り値: { ok, preview, id, changed, content }。",
    {
      id: z.string().min(1).describe("tl_contents の id"),
      updates: z
        .record(z.string(), z.any())
        .describe("書き換える欄と値。例: { \"status\": \"published\", \"title\": \"新しい見出し\" }"),
      reason: z.string().min(1).describe("書き換える理由（空文字は不可）"),
      preview: z.boolean().optional().describe("true で書かずに前後の値だけを返す（デフォルト false）"),
    },
    async (args) => {
      const preview = args.preview ?? false;
      const keys = Object.keys(args.updates ?? {});
      if (keys.length === 0) {
        return asMcpTextResult({ ok: false, error: "updates が空です。書き換える欄を 1 つ以上渡してください" });
      }
      const forbidden = keys.filter((k) => FORBIDDEN_COLUMNS.includes(k));
      if (forbidden.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: `書き換えられない欄が含まれています：${forbidden.join(" / ")}`,
          forbidden_columns: FORBIDDEN_COLUMNS,
        });
      }
      const beforeRows = await sbGet(
        env,
        `/${CONTENT_TABLE}?select=*&id=eq.${encodeURIComponent(args.id)}&limit=1`
      );
      if (beforeRows.length === 0) {
        return asMcpTextResult({ ok: false, error: `id=${args.id} が見つかりません` });
      }
      const before = beforeRows[0];
      const unknown = keys.filter((k) => !(k in before));
      if (unknown.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: `表に無い欄が含まれています：${unknown.join(" / ")}`,
          columns_in_table: Object.keys(before),
        });
      }
      const changed: Record<string, { before: unknown; after: unknown }> = {};
      for (const k of keys) changed[k] = { before: before[k], after: (args.updates as Row)[k] };
      if (preview) {
        return asMcpTextResult({
          ok: true,
          preview: true,
          id: args.id,
          reason: args.reason,
          changed,
          note: "書いていません。実行するには preview を外して同じ内容で呼び直してください",
        });
      }
      const patch: Row = { ...(args.updates as Row), updated_at: nowIso() };
      if (
        (args.updates as Row).status === "published" &&
        !("published_at" in (args.updates as Row)) &&
        !before.published_at
      ) {
        patch.published_at = nowIso();
      }
      await sbPatch(env, `/${CONTENT_TABLE}?id=eq.${encodeURIComponent(args.id)}`, patch);
      const afterRows = await sbGet(
        env,
        `/${CONTENT_TABLE}?select=*&id=eq.${encodeURIComponent(args.id)}&limit=1`
      );
      const after = afterRows[0] ?? {};
      for (const k of keys) changed[k] = { before: before[k], after: after[k] };
      const notSaved = keys.filter(
        (k) => JSON.stringify(after[k]) !== JSON.stringify((args.updates as Row)[k])
      );
      return asMcpTextResult({
        ok: notSaved.length === 0,
        preview: false,
        id: args.id,
        reason: args.reason,
        changed,
        not_saved: notSaved,
        content: after,
      });
    }
  );

  // ─── 5. tsumiage__list_note_links ──────────────────────────────
  server.tool(
    "tsumiage__list_note_links",
    "公式サイトに並んでいる note のリンク一覧を取る。公開日の新しい順で返す。戻り値: { ok, total, note_links: [行] }。",
    {
      status: z.enum(["published", "archived"]).optional().describe("状態でしぼる。省略時は published だけ"),
      limit: z.number().int().min(1).max(200).optional().describe("最大件数（デフォルト 50）"),
    },
    async (args) => {
      const q: string[] = [
        "select=*",
        "order=published_at.desc.nullslast,created_at.desc",
        `limit=${args.limit ?? 50}`,
        `status=eq.${args.status ?? "published"}`,
      ];
      const rows = await sbGet(env, `/${NOTE_TABLE}?${q.join("&")}`);
      return asMcpTextResult({ ok: true, total: rows.length, note_links: rows });
    }
  );

  // ─── 6. tsumiage__add_note_link ───────────────────────────────
  server.tool(
    "tsumiage__add_note_link",
    "note の記事のリンクを 1 件足す。並べ替えはしない（公開日の新しい順で自動で並ぶ）。同じ住所がすでにあったら、上書きせずに止めて既存の行を返す。戻り値: { ok, note_link: 入った行 }。",
    {
      url: z.string().min(1).describe("note の記事の住所"),
      title: z.string().min(1).describe("見出し"),
      summary: z.string().optional().describe("一覧に出す短い説明"),
      thumbnail_url: z.string().optional().describe("一覧に出す画像の住所"),
      is_membership: z.boolean().optional().describe("メンバーシップ限定なら true（デフォルト false）"),
      published_at: z.string().optional().describe("公開日時（ISO 8601）。省略時は今の時刻"),
    },
    async (args) => {
      const existing = await sbGet(
        env,
        `/${NOTE_TABLE}?select=id,url,title,status&url=eq.${encodeURIComponent(args.url)}&limit=1`
      );
      if (existing.length > 0) {
        return asMcpTextResult({
          ok: false,
          error: "同じ住所がすでにあります。上書きせずに止めました",
          existing: existing[0],
        });
      }
      const row: Row = {
        user_id: env.MCP_DEFAULT_USER_ID,
        url: args.url,
        title: args.title,
        summary: args.summary ?? null,
        thumbnail_url: args.thumbnail_url ?? null,
        is_membership: args.is_membership ?? false,
        published_at: args.published_at ?? nowIso(),
        status: "published",
        updated_at: nowIso(),
      };
      const inserted = await sbPost(env, `/${NOTE_TABLE}`, row);
      return asMcpTextResult({ ok: inserted.length === 1, note_link: inserted[0] ?? null });
    }
  );
}
