/**
 * shia2n-mcp / src/tools-evolab.ts / 初版（2026-08-25 開発部）
 *
 * 進化ラボ（公式サイト）に記事を 1 本入れる口。
 * 受け口は shia2n-site の /api/ingest/contents。
 * 合い言葉（SITE_INGEST_SECRET）を見出しに付けて送る。
 * 命名規約：`evolab__<action>`
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

export function registerEvolabTools(server: McpServer, env: Env): void {
  server.tool(
    "evolab__put_article",
    "進化ラボ（公式サイト evolab.shia2n.jp）に記事を 1 本入れる。slug が同じ行がすでにあれば書き換えるので、何回送っても行は増えない。status を published にすると公開され、ログインなしで見せる 3 本（roadmap / x-basic-100 / god-brain-training）のいずれかなら、そのまま画面に出る。tags にはカテゴリの名前を入れる（習慣 / AI仕事術 / 思考力 / マインドセット / 言語化 / SNS攻略 / ビジネス / 生存戦略 / 初心者入門 / 特典コンテンツ（無料））。戻り値: { status, result }。result.saved に入った行が入る。",
    {
      slug:  z.string().describe("住所になる短い英字。既存と同じにするとその行を書き換える（必須）"),
      title: z.string().describe("題名（必須）"),
      summary:      z.string().optional().describe("一覧に出る短い説明"),
      body:         z.string().optional().describe("本文。一覧には出ない"),
      tags:         z.array(z.string()).optional().describe("カテゴリの名前の配列。省略時は空"),
      level:        z.number().int().min(1).max(4).optional().describe("級。1=初級。省略時は 1"),
      kind:         z.enum(["article", "video"]).optional().describe("種類。省略時は article"),
      status:       z.enum(["draft", "published", "archived"]).optional().describe("状態。省略時は draft（画面には出ない）"),
      video_url:    z.string().optional().describe("動画の住所"),
      cover_url:    z.string().optional().describe("表紙の画像の住所"),
    },
    async (args) => {
      const base   = (env.SITE_API_BASE ?? "https://evolab.shia2n.jp").replace(/\/+$/, "");
      const secret = env.SITE_INGEST_SECRET ?? "";

      if (!secret) {
        return asMcpTextResult({
          ok: false,
          message: "合い言葉が設定されていません（SITE_INGEST_SECRET）。",
        });
      }

      let upstream: Response;
      try {
        upstream = await fetch(`${base}/api/ingest/contents`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ingest-secret": secret,
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        return asMcpTextResult({ ok: false, message: "進化ラボにつながりませんでした。" });
      }

      const text = await upstream.text();
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text.slice(0, 300) };
      }

      return asMcpTextResult({ status: upstream.status, result });
    }
  );
}