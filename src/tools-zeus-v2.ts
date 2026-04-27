import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * Zeus v2（知的生産システム中央リポジトリ）用のツールを登録する。
 * 外部公開API（/api/external/*）を ZEUS_EXTERNAL_SECRET で呼ぶ。
 *
 * v1 ツール（zeus__search 等）は tools-zeus.ts で引き続き管理。
 * 命名規約：`zeus_v2__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 */

const ZEUS_EXTERNAL_BASE = "https://zeus.shia2n.jp/api/external";

async function callZeusExternal<T = unknown>(
  env: Env,
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>
): Promise<T> {
  let url = `${ZEUS_EXTERNAL_BASE}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${env.ZEUS_EXTERNAL_SECRET}`,
      "Content-Type": "application/json",
    },
  };

  if (method === "GET" && payload) {
    const qs = new URLSearchParams(
      Object.entries(payload)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString();
    if (qs) url += "?" + qs;
  } else if (method === "POST" && payload) {
    opts.body = JSON.stringify(payload);
  }

  let res: Response;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`upstream_network_error: ${msg}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upstream_error: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export function registerZeusV2Tools(server: McpServer, env: Env): void {
  // ─── 1. zeus_v2__push ────────────────────────────────────────────────
  server.tool(
    "zeus_v2__push",
    "Zeus v2（知的生産システム中央リポジトリ）にデータを投入する。テキスト・URL・ファイルを受け付け、自動でタイプ判定とEmbedding生成を行う。プロジェクト所属を指定可能。壁打ち中に重要な洞察・決定事項が出たときに使う。Claudeは呼び出し前に『これをZeusに保存しますか？』と確認すること。戻り値: { ok, item_id, item_type, title }。",
    {
      title: z
        .string()
        .optional()
        .describe("データの見出し（省略時は自動生成）"),
      content: z
        .string()
        .optional()
        .describe("テキスト本文（Markdown可）"),
      source_url: z
        .string()
        .optional()
        .describe("URL（WebクリップはURLのみでもOK、OGタグ自動取得）"),
      project_ids: z
        .array(z.string())
        .optional()
        .describe("所属プロジェクトIDの配列（zeus_v2__list_projects で取得）"),
      folder_id: z
        .string()
        .optional()
        .describe("所属フォルダID"),
      source_app: z
        .string()
        .optional()
        .describe("呼び出し元アプリ名（例: 'claude-chat', 'mind-modeling'。省略時は 'claude-chat'）"),
    },
    async (args) => {
      const result = await callZeusExternal(env, "POST", "/push-to-zeus", {
        user_id:    env.MCP_DEFAULT_USER_ID,
        source_app: args.source_app ?? "claude-chat",
        ...args,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 2. zeus_v2__search ──────────────────────────────────────────────
  server.tool(
    "zeus_v2__search",
    "Zeus v2 からベクトル検索でナレッジを取得する。クエリと意味的に近いデータを返す（言葉のゆらぎに強い）。プロジェクト指定検索・タイプフィルタが可能。snippet は先頭200文字のみ。全文が必要なときは zeus_v2__pull を使う。壁打ち前に Zeus から文脈を引き出したいときに使う。戻り値: { ok, results: [{id, title, snippet, item_type, project_ids, similarity, created_at}] }。",
    {
      q: z
        .string()
        .describe("検索クエリ（自然文でOK、例：『発信軸の決め方』『クライアントに伝わる言葉の選び方』）"),
      project_id: z
        .string()
        .optional()
        .describe("プロジェクトIDで絞り込み（省略時は全体検索）"),
      item_types: z
        .array(z.string())
        .optional()
        .describe("タイプフィルタ（text / pdf / video_link / web_clip / image / audio）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("返す件数（既定5、上限20）"),
    },
    async (args) => {
      const result = await callZeusExternal(env, "GET", "/search-zeus", {
        user_id:    env.MCP_DEFAULT_USER_ID,
        q:          args.q,
        project_id: args.project_id,
        item_types: args.item_types?.join(","),
        limit:      args.limit ?? 5,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 3. zeus_v2__pull ────────────────────────────────────────────────
  server.tool(
    "zeus_v2__pull",
    "Zeus v2 から特定データをID指定でフル取得する。zeus_v2__search で見つけたデータのフル content・メタデータ・所属プロジェクト情報を取得する。戻り値: { ok, item: {id, title, content, item_type, project_ids, folder_id, source_app, source_url, created_at, updated_at} }。",
    {
      item_id: z
        .string()
        .describe("取得するデータのID（zeus_v2__search の結果 id フィールド、必須）"),
    },
    async (args) => {
      const result = await callZeusExternal(env, "GET", "/pull-from-zeus", {
        item_id: args.item_id,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 4. zeus_v2__list_projects ───────────────────────────────────────
  server.tool(
    "zeus_v2__list_projects",
    "Zeus v2 のプロジェクト一覧を取得する。zeus_v2__push でデータを投入するプロジェクトを選ぶときや、どんな分類があるか把握したいときに使う。戻り値: { ok, projects: [{id, name, description, item_count, created_at}] }。",
    {},
    async () => {
      const result = await callZeusExternal(env, "GET", "/list-projects", {
        user_id: env.MCP_DEFAULT_USER_ID,
      });
      return asMcpTextResult(result);
    }
  );
}
