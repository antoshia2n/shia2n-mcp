import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";

/**
 * コンテンツ管理シートのうち、Whimsical の補強に要る 2 つだけを触る道具。
 * 命名規約：content_sheet__<action>
 *
 * 2026-09-09 新設（段 3・Whimsical の補強を定期実行にする）
 *   ・読むのは A から P までのうち、見分けに要る A・C・E と F・J・K だけ
 *   ・書くのは K（補強完了）だけ。他の列へは書かない
 *   ・シートの持ち主は Naoki。FIREBASE_SA_EMAIL に編集者で共有してもらう前提
 *   ・行の番号だけで書くと行がずれたときに別の行へ入るので、
 *     書く前に E 列（タイトル）が一致するかを必ず見る
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const COL_DATE = 0;
const COL_PLATFORM = 2;
const COL_TITLE = 4;
const COL_WHIMSICAL = 5;
const COL_REQUEST = 9;
const COL_DONE = 10;

function jstYear(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return String(d.getUTCFullYear());
}

function monthTabs(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

function isChecked(value: string | undefined): boolean {
  return (value ?? "").trim().toUpperCase() === "TRUE";
}

function sheetId(env: Env): string {
  const id = env.CONTENT_SHEET_ID?.trim() ?? "";
  if (!id) throw new Error("CONTENT_SHEET_ID が入っていません（管理シートの番号）");
  return id;
}

async function sheetsJson<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export function registerContentSheetTools(server: McpServer, env: Env): void {
  server.tool(
    "content_sheet__list_reinforce_targets",
    "コンテンツ管理シートから、補強依頼（J 列）にチェックがあり補強完了（K 列）が空の行を返す。Whimsical の板を補強する対象の一覧。",
    {
      year: z.string().optional().describe("見に行く年（既定は日本時間の今年）。例：2026"),
    },
    async ({ year }) => {
      const token = await getGoogleTokenForScope(env, SCOPE);
      const id = sheetId(env);
      const tabs = monthTabs((year ?? "").trim() || jstYear());
      const query = tabs
        .map((tab) => `ranges=${encodeURIComponent(`${tab}!A2:P500`)}`)
        .join("&");
      const got = await sheetsJson<{ valueRanges?: { values?: string[][] }[] }>(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?majorDimension=ROWS&${query}`
      );

      const targets: Record<string, unknown>[] = [];
      tabs.forEach((tab, tabIndex) => {
        (got.valueRanges?.[tabIndex]?.values ?? []).forEach((row, rowIndex) => {
          if (!isChecked(row[COL_REQUEST])) return;
          if ((row[COL_DONE] ?? "").trim() !== "") return;
          targets.push({
            tab,
            row_no: rowIndex + 2,
            date: (row[COL_DATE] ?? "").trim(),
            platform: (row[COL_PLATFORM] ?? "").trim(),
            title: (row[COL_TITLE] ?? "").trim(),
            whimsical_url: (row[COL_WHIMSICAL] ?? "").trim(),
          });
        });
      });

      return asMcpTextResult({ ok: true, total: targets.length, targets });
    }
  );

  server.tool(
    "content_sheet__mark_reinforced",
    "指定した行の補強完了（K 列）にチェックを入れる。行がずれていないかを E 列のタイトルで確かめてから書く。",
    {
      tab: z.string().describe("タブの名前。例：2026-09"),
      row_no: z.number().int().min(2).describe("シートの行番号（2 以上）"),
      expect_title: z.string().describe("その行に入っているはずのタイトル（E 列）"),
    },
    async ({ tab, row_no, expect_title }) => {
      const token = await getGoogleTokenForScope(env, SCOPE);
      const id = sheetId(env);

      const got = await sheetsJson<{ values?: string[][] }>(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(
          `${tab}!A${row_no}:P${row_no}`
        )}`
      );
      const row = got.values?.[0] ?? [];
      const found = (row[COL_TITLE] ?? "").trim();
      if (found !== expect_title.trim()) {
        return asMcpTextResult({
          ok: false,
          reason: "行のタイトルが一致しません。行がずれた可能性があるので書きませんでした",
          tab,
          row_no,
          found_title: found,
          expect_title: expect_title.trim(),
        });
      }

      await sheetsJson(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(
          `${tab}!K${row_no}`
        )}?valueInputOption=USER_ENTERED`,
        { method: "PUT", body: JSON.stringify({ values: [["TRUE"]] }) }
      );

      return asMcpTextResult({ ok: true, tab, row_no, title: found });
    }
  );
}
