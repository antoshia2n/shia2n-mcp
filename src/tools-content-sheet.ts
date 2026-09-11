import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";

/**
 * コンテンツ管理シートを触る道具（補強の 2 本と、予定の行を足す 1 本）。
 * 命名規約：content_sheet__<action>
 *
 * 2026-09-11 追加（v0.80.0・統括の仕様）：content_sheet__add_plan_row
 *   ・行を足すだけ。すでにある行の A〜Q には 1 文字も書かない
 *   ・書くのは A・C・D・E の 4 つだけ（機械の列 B・G・H・I・K・L・N・O・P と、Naoki の手の列 F・J・M・Q には書かない）
 *   ・C に入れてよいのは X記事・Xポスト・note記事 の 3 つだけ（セミナーの行には録画が合わさるため受け付けない）
 *   ・空き行の見つけ方は受け付けの処理（zoom-to-youtube の src/manage.ts）と同じ：A〜I と L〜P がすべて空の行
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

// 予定の行を足す口（content_sheet__add_plan_row）だけが使う値
const COL_THEME = 3;
const PLAN_SHEET_YEAR = "2026";
const PLAN_PLATFORMS = ["X記事", "Xポスト", "note記事"];
// 空き行の判定に使う列：A〜I と L〜P（受け付けの処理の manage.ts と同じ並び）。J・K・Q はチェックの印で FALSE と読めるので使わない
const PLAN_OCCUPIED_COLUMNS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 15];
// 書いたあとに空であることを確かめる列：G・H・I・L・M・N・O（J・K はチェックの印なので TRUE でなければよい）
const PLAN_EMPTY_AFTER = [6, 7, 8, 11, 12, 13, 14];
const PLAN_CHECK_AFTER = [9, 10];
const SHEET_LETTERS = "ABCDEFGHIJKLMNOPQ";

function isPlanDate(value: string): boolean {
  if (value.length !== 10 || value[4] !== "-" || value[7] !== "-") return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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
          if (isChecked(row[COL_DONE])) return;
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

  server.tool(
    "content_sheet__add_plan_row",
    "コンテンツ管理シートに予定の行を 1 本足す。書くのは A（投稿予定日）・C（媒体）・D（テーマ）・E（タイトル）の 4 つだけで、すでにある行やほかの列には書かない。媒体は X記事・Xポスト・note記事 の 3 つだけ受け付ける（セミナーは受け付けない）。入れ先のタブは投稿予定日の年月で、2026 年だけ。同じタブに投稿予定日とタイトルが同じ行があれば、足さずにその行を返す。dry_run=true なら書かずに入れ先のタブと行だけを返す。行ができると、受け付けの処理（5 分ごと）がコンテンツくんに枠を作る。",
    {
      date: z.string().describe("投稿予定日（YYYY-MM-DD）。例：2026-09-20"),
      platform: z.string().describe("媒体。X記事・Xポスト・note記事 のどれか"),
      theme: z.string().describe("テーマ（D 列）。空は受け付けない"),
      title: z.string().describe("タイトル（E 列）。空は受け付けない"),
      dry_run: z.boolean().optional().describe("true なら書かずに、入れ先のタブと行だけを返す"),
    },
    async ({ date, platform, theme, title, dry_run }) => {
      const want = { date: date.trim(), platform: platform.trim(), theme: theme.trim(), title: title.trim() };
      const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
        asMcpTextResult({ ok: false, written: false, reason, ...want, ...extra });

      if (!want.date || !want.platform || !want.theme || !want.title) {
        return refuse("date・platform・theme・title の 4 つとも必須です。空のものがあるので書きませんでした");
      }
      if (!isPlanDate(want.date)) {
        return refuse("date は YYYY-MM-DD の形の、実在する日付で渡してください。書きませんでした");
      }
      if (want.date.slice(0, 4) !== PLAN_SHEET_YEAR) {
        return refuse(`管理シートは ${PLAN_SHEET_YEAR} 年のファイルしかありません。書きませんでした`);
      }
      if (!PLAN_PLATFORMS.includes(want.platform)) {
        return refuse(
          want.platform === "セミナー"
            ? "セミナーは受け付けません（同じ日付でセミナーの行へ録画が合わさる道があるため）。書きませんでした"
            : "platform は X記事・Xポスト・note記事 のどれかだけです。書きませんでした"
        );
      }

      const tab = want.date.slice(0, 7);
      const token = await getGoogleTokenForScope(env, SCOPE);
      const id = sheetId(env);
      const got = await sheetsJson<{ values?: string[][] }>(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!A2:Q500`)}`
      );
      const rows = got.values ?? [];

      // 同じタブに A と E が同じ行があれば、足さずにその行を返す（2 回呼ばれて枠が 2 つできるのを防ぐ）
      const sameIndex = rows.findIndex(
        (row) =>
          (row[COL_DATE] ?? "").trim().slice(0, 10) === want.date && (row[COL_TITLE] ?? "").trim() === want.title
      );
      if (sameIndex >= 0) {
        const row = rows[sameIndex];
        return asMcpTextResult({
          ok: true,
          written: false,
          existed: true,
          dry_run: dry_run === true,
          reason: "同じ投稿予定日とタイトルの行がすでにあるので、足しませんでした",
          tab,
          row_no: sameIndex + 2,
          date: (row[COL_DATE] ?? "").trim(),
          platform: (row[COL_PLATFORM] ?? "").trim(),
          theme: (row[COL_THEME] ?? "").trim(),
          title: (row[COL_TITLE] ?? "").trim(),
        });
      }

      // 空き行：A〜I と L〜P がすべて空の行（受け付けの処理と同じ見つけ方）
      let rowNo = 2;
      while (rowNo <= 500 && PLAN_OCCUPIED_COLUMNS.some((column) => (rows[rowNo - 2]?.[column] ?? "") !== "")) {
        rowNo += 1;
      }
      if (rowNo > 500) {
        return refuse(`${tab} の 2 行目から 500 行目に空きがありません。書きませんでした`, { tab });
      }

      if (dry_run === true) {
        return asMcpTextResult({ ok: true, written: false, existed: false, dry_run: true, tab, row_no: rowNo, ...want });
      }

      // C・D・E は文字のまま（RAW）。A は最後に、手で打った行と同じく日付として入れる（USER_ENTERED）
      await sheetsJson(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(
          `${tab}!C${rowNo}:E${rowNo}`
        )}?valueInputOption=RAW`,
        { method: "PUT", body: JSON.stringify({ values: [[want.platform, want.theme, want.title]] }) }
      );
      await sheetsJson(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(
          `${tab}!A${rowNo}`
        )}?valueInputOption=USER_ENTERED`,
        { method: "PUT", body: JSON.stringify({ values: [[want.date]] }) }
      );

      // 書いたあとに同じ行を読み直す。受け付けの処理が同じ空き行へ書いたときに黙らないため
      const after = await sheetsJson<{ values?: string[][] }>(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!A${rowNo}:Q${rowNo}`)}`
      );
      const written = after.values?.[0] ?? [];
      const cell = (column: number) => (written[column] ?? "").trim();
      const fourOk =
        cell(COL_DATE).slice(0, 10) === want.date &&
        cell(COL_PLATFORM) === want.platform &&
        cell(COL_THEME) === want.theme &&
        cell(COL_TITLE) === want.title;
      const restEmpty =
        PLAN_EMPTY_AFTER.every((column) => cell(column) === "") &&
        PLAN_CHECK_AFTER.every((column) => cell(column).toUpperCase() !== "TRUE");
      if (!fourOk || !restEmpty) {
        const rowView: Record<string, string> = {};
        SHEET_LETTERS.split("").forEach((letter, index) => {
          rowView[letter] = written[index] ?? "";
        });
        return asMcpTextResult({
          ok: false,
          written: true,
          reason: "書いたあとに読み直すと、行の中身が合いません。受け付けの処理が同じ行へ書いた可能性があります",
          tab,
          row_no: rowNo,
          row: rowView,
        });
      }

      return asMcpTextResult({ ok: true, written: true, existed: false, dry_run: false, tab, row_no: rowNo, ...want });
    }
  );
}
