import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";

/**
 * るーみんの YouTube 台本台帳（Google スプレッドシート）を触る道具。
 * 命名規約：rumin_script__<action>
 *
 * 2026-09-22 新設（v0.84.0・Naoki 依頼・るーみん案件）：rumin_script__put_row
 *   ・MTG では先生とシアニンが手で書き、納品時は Claude がこの口で書く
 *   ・撮影番号（例：撮6）で行を探し、書くのは「台本を開く」「状態」「決めてほしいこと」の 3 列だけ
 *   ・行が無ければ末尾に 1 行足す（そのときだけ「撮影番号」も書く）。ほかの列には 1 文字も書かない
 *   ・人が入れた「状態」を上書きしてよいのは「先生確認待ち」にするときだけ。
 *     それ以外の値へは、空のときだけ書く。書かなかったときは warnings に理由を返す
 *   ・「状態」はシートのプルダウンの値のどれかだけを受け付ける（プルダウンをシートから読む）
 *   ・列は位置ではなく見出しの文字で探す（ファイルを作り直しても口を直さずに済むため）。
 *     見出しの末尾の（…）は見ない。「台本を開く（URL）」も「台本を開く」も同じ列として扱う
 *   ・シートの番号は RUMIN_SCRIPT_SHEET_ID（シークレット）。置き場が公開なので vars には書かない
 *   ・Google へは FIREBASE_SA_EMAIL の機械用の身分で入る。台帳をそのメールアドレスへ編集者で共有する前提
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export const HEAD_SHOOT = "撮影番号";
export const HEAD_URL = "台本を開く";
export const HEAD_STATUS = "状態";
export const HEAD_ASK = "決めてほしいこと";
/** 人が入れた「状態」を上書きしてよい、ただ 1 つの値 */
export const STATUS_OVERWRITE_ALLOWED = "先生確認待ち";
/** 見出しを探す行の数（1 行目から数える） */
const HEADER_SCAN_ROWS = 5;

export type SheetsJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface PutRowInput {
  shoot_no: string;
  script_url?: string;
  status?: string;
  ask?: string;
  tab?: string;
  dry_run?: boolean;
}

type Cells = string[][];

/** 見出しの見分け：全角半角をそろえ、空白を外し、末尾の（…）を外す */
export function headKey(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/\([^()]*\)$/, "");
}

/** 撮影番号の見分け：全角半角をそろえ、空白を外す（「撮６」「撮 6」も「撮6」として扱う） */
export function shootKey(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, "");
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export interface HeaderHit {
  headerRow: number; // 1 始まり
  shoot: number;
  url: number;
  status: number;
  ask: number;
}

/** 1 行目から HEADER_SCAN_ROWS 行目までで、4 つの見出しがそろう最初の行を探す。同じ見出しが 2 つある行は使わない */
export function findHeader(values: Cells): HeaderHit | { error: string } {
  const wanted = [HEAD_SHOOT, HEAD_URL, HEAD_STATUS, HEAD_ASK];
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, values.length); r++) {
    const keys = (values[r] ?? []).map((cell) => headKey(cell));
    const positions = wanted.map((w) => keys.flatMap((k, i) => (k === w ? [i] : [])));
    if (positions.every((p) => p.length >= 1)) {
      const dup = wanted.filter((_, i) => positions[i].length > 1);
      if (dup.length > 0) return { error: `見出し ${dup.join("・")} が同じ行に 2 つ以上あります（${r + 1} 行目）` };
      return {
        headerRow: r + 1,
        shoot: positions[0][0],
        url: positions[1][0],
        status: positions[2][0],
        ask: positions[3][0],
      };
    }
  }
  return { error: `1〜${HEADER_SCAN_ROWS} 行目に、見出し ${wanted.join("・")} の 4 つがそろう行がありません` };
}

/** 値が入っている最後の行の番号（1 始まり）。空なら 0 */
export function lastFilledRow(values: Cells): number {
  for (let r = values.length - 1; r >= 0; r--) {
    if ((values[r] ?? []).some((cell) => (cell ?? "").trim() !== "")) return r + 1;
  }
  return 0;
}

/** 「状態」を書くかどうかの判定（人が入れた値を守る決まりはここだけ） */
export function decideStatus(
  current: string,
  requested: string
): { write: boolean; reason?: string } {
  if (requested === current) return { write: false, reason: "すでに同じ値なので書いていません" };
  if (current === "") return { write: true };
  if (requested === STATUS_OVERWRITE_ALLOWED) return { write: true };
  return {
    write: false,
    reason: `状態に人が入れた値「${current}」があるため「${requested}」で上書きしませんでした（上書きしてよいのは「${STATUS_OVERWRITE_ALLOWED}」にするときだけ）`,
  };
}

type Validation = { condition?: { type?: string; values?: { userEnteredValue?: string }[] } };
type GridResponse = {
  sheets?: { data?: { rowData?: { values?: { dataValidation?: Validation }[] }[] }[] }[];
};

/** 「状態」の列のプルダウンの値を、シートから読む。ONE_OF_LIST と ONE_OF_RANGE の 2 種だけを見る */
async function readStatusOptions(
  sheets: SheetsJson,
  id: string,
  tab: string,
  column: number,
  fromRow: number,
  toRow: number
): Promise<string[]> {
  const letter = columnLetter(column);
  const range = `${quoteTab(tab)}!${letter}${fromRow}:${letter}${toRow}`;
  const grid = await sheets<GridResponse>(
    `${API}/${id}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(
      "sheets(data(rowData(values(dataValidation))))"
    )}`
  );
  const options = new Set<string>();
  const rangeRefs = new Set<string>();
  for (const sheet of grid.sheets ?? []) {
    for (const data of sheet.data ?? []) {
      for (const row of data.rowData ?? []) {
        for (const cell of row.values ?? []) {
          const cond = cell.dataValidation?.condition;
          if (!cond) continue;
          if (cond.type === "ONE_OF_LIST") {
            for (const v of cond.values ?? []) {
              const text = (v.userEnteredValue ?? "").trim();
              if (text) options.add(text);
            }
          } else if (cond.type === "ONE_OF_RANGE") {
            const ref = (cond.values?.[0]?.userEnteredValue ?? "").replace(/^=/, "").replace(/\$/g, "").trim();
            if (ref) rangeRefs.add(ref);
          }
        }
      }
    }
  }
  for (const ref of rangeRefs) {
    const got = await sheets<{ values?: Cells }>(`${API}/${id}/values/${encodeURIComponent(ref)}`);
    for (const row of got.values ?? []) {
      for (const cell of row) {
        const text = (cell ?? "").trim();
        if (text) options.add(text);
      }
    }
  }
  return [...options];
}

/**
 * 口の中身。Google への呼び出しは sheets に寄せてあるので、偽物を渡せば手元で通しで確かめられる。
 */
export async function putRuminScriptRow(
  sheets: SheetsJson,
  id: string,
  input: PutRowInput
): Promise<Record<string, unknown>> {
  const shootNo = shootKey(input.shoot_no);
  const want = {
    script_url: input.script_url === undefined ? undefined : input.script_url.trim(),
    status: input.status === undefined ? undefined : input.status.trim(),
    ask: input.ask === undefined ? undefined : input.ask.trim(),
  };
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    written: false,
    reason,
    shoot_no: shootNo,
    ...extra,
  });

  // ── 受け付ける形か（ここで止まったら Google には 1 回も触らない）
  if (!shootNo) return refuse("shoot_no（撮影番号）が空です。書きませんでした");
  if (!shootNo.startsWith("撮") || shootNo.length > 20) {
    return refuse("shoot_no は「撮6」の形で渡してください（撮 で始まる 20 文字以内）。書きませんでした");
  }
  if (want.script_url === undefined && want.status === undefined && want.ask === undefined) {
    return refuse("script_url・status・ask のどれか 1 つは渡してください。書きませんでした");
  }
  if (want.script_url !== undefined && (!/^https:\/\/\S+$/.test(want.script_url) || want.script_url.length > 2000)) {
    return refuse("script_url は https:// で始まる住所 1 本だけを渡してください（空白なし）。書きませんでした");
  }
  if (want.status !== undefined && want.status === "") {
    return refuse("status を空で渡すことはできません（消す口ではありません）。書きませんでした");
  }
  if (want.ask !== undefined && (want.ask === "" || want.ask.length > 300)) {
    return refuse("ask（決めてほしいこと）は 1〜300 文字で渡してください。書きませんでした");
  }

  // ── どのタブか：4 つの見出しがそろうタブがちょうど 1 つ（tab を渡したらそのタブだけ見る）
  const meta = await sheets<{ sheets?: { properties?: { title?: string } }[] }>(
    `${API}/${id}?fields=${encodeURIComponent("sheets.properties.title")}`
  );
  const allTabs = (meta.sheets ?? []).map((s) => s.properties?.title ?? "").filter((t) => t !== "");
  const tabWanted = (input.tab ?? "").trim();
  if (tabWanted && !allTabs.includes(tabWanted)) {
    return refuse(`タブ「${tabWanted}」がありません。書きませんでした`, { tabs: allTabs });
  }
  const candidates = tabWanted ? [tabWanted] : allTabs;
  const batch = await sheets<{ valueRanges?: { values?: Cells }[] }>(
    `${API}/${id}/values:batchGet?majorDimension=ROWS&${candidates
      .map((t) => `ranges=${encodeURIComponent(quoteTab(t))}`)
      .join("&")}`
  );
  const hits: { tab: string; values: Cells; header: HeaderHit }[] = [];
  const misses: Record<string, string> = {};
  candidates.forEach((tab, i) => {
    const values = batch.valueRanges?.[i]?.values ?? [];
    const found = findHeader(values);
    if ("error" in found) misses[tab] = found.error;
    else hits.push({ tab, values, header: found });
  });
  if (hits.length !== 1) {
    return refuse(
      hits.length === 0
        ? "4 つの見出しがそろうタブがありません。書きませんでした"
        : `4 つの見出しがそろうタブが ${hits.length} つあります。tab でどれかを指定してください。書きませんでした`,
      { tabs_with_headers: hits.map((h) => h.tab), tabs_without_headers: misses }
    );
  }
  const { tab, values, header } = hits[0];

  // ── どの行か：撮影番号が同じ行がちょうど 1 つならその行。0 なら末尾に足す。2 つ以上なら止める
  const matched: number[] = [];
  for (let r = header.headerRow; r < values.length; r++) {
    if (shootKey(values[r]?.[header.shoot]) === shootNo) matched.push(r + 1);
  }
  if (matched.length > 1) {
    return refuse(`撮影番号 ${shootNo} の行が ${matched.length} 行あります（${matched.join("・")} 行目）。どれに書くか決められないので書きませんでした`, { tab });
  }
  const adding = matched.length === 0;
  const rowNo = adding ? Math.max(lastFilledRow(values), header.headerRow) + 1 : matched[0];
  const rowNow = adding ? [] : values[rowNo - 1] ?? [];
  const before = {
    script_url: (rowNow[header.url] ?? "").trim(),
    status: (rowNow[header.status] ?? "").trim(),
    ask: (rowNow[header.ask] ?? "").trim(),
  };

  // ── 状態：プルダウンの値のどれかか。人が入れた値を守る決まりを通るか
  const warnings: string[] = [];
  let statusOptions: string[] | undefined;
  let statusWrite = false;
  if (want.status !== undefined) {
    const lastRow = Math.max(lastFilledRow(values), header.headerRow + 1, rowNo);
    statusOptions = await readStatusOptions(sheets, id, tab, header.status, header.headerRow + 1, lastRow);
    if (statusOptions.length === 0) {
      return refuse("「状態」の列にプルダウンが見つかりません。値を確かめられないので書きませんでした", { tab, row_no: rowNo });
    }
    if (!statusOptions.includes(want.status)) {
      return refuse(`status「${want.status}」はプルダウンの値にありません。書きませんでした`, {
        tab,
        row_no: rowNo,
        status_options: statusOptions,
      });
    }
    const decision = decideStatus(before.status, want.status);
    statusWrite = decision.write;
    if (!decision.write && decision.reason && want.status !== before.status) warnings.push(decision.reason);
  }

  // ── 書く中身を決める（変わるセルだけ）
  const updates: { column: number; value: string; field: string }[] = [];
  if (adding) updates.push({ column: header.shoot, value: shootNo, field: "shoot_no" });
  if (want.script_url !== undefined && want.script_url !== before.script_url) {
    updates.push({ column: header.url, value: want.script_url, field: "script_url" });
  }
  if (want.status !== undefined && statusWrite) {
    updates.push({ column: header.status, value: want.status, field: "status" });
  }
  if (want.ask !== undefined && want.ask !== before.ask) {
    updates.push({ column: header.ask, value: want.ask, field: "ask" });
  }

  const after = { ...before };
  for (const u of updates) if (u.field !== "shoot_no") (after as Record<string, string>)[u.field] = u.value;
  const base = {
    tab,
    row_no: rowNo,
    shoot_no: shootNo,
    action: updates.length === 0 ? "unchanged" : adding ? "added" : "updated",
    before,
    after,
    changed: updates.map((u) => u.field),
    warnings,
  };

  if (updates.length === 0 || input.dry_run === true) {
    return { ok: true, written: false, dry_run: input.dry_run === true, ...base };
  }

  // ── 書く。RAW なので「=」で始まる文も式にはならない
  await sheets(`${API}/${id}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: updates.map((u) => ({
        range: `${quoteTab(tab)}!${columnLetter(u.column)}${rowNo}`,
        values: [[u.value]],
      })),
    }),
  });

  // ── 書いたあとに同じ行を読み直す。書いたセルが書いた値になっているか・撮影番号がずれていないか
  const reread = await sheets<{ values?: Cells }>(
    `${API}/${id}/values/${encodeURIComponent(`${quoteTab(tab)}!${rowNo}:${rowNo}`)}`
  );
  const rowAfter = reread.values?.[0] ?? [];
  const mismatched = updates.filter((u) => (rowAfter[u.column] ?? "").trim() !== u.value);
  const shootAfter = shootKey(rowAfter[header.shoot]);
  if (mismatched.length > 0 || shootAfter !== shootNo) {
    return {
      ok: false,
      written: true,
      reason: "書いたあとに読み直すと、行の中身が合いません。人が同時にこの行を触った可能性があります",
      ...base,
      mismatched: mismatched.map((u) => ({ field: u.field, wrote: u.value, found: (rowAfter[u.column] ?? "").trim() })),
      shoot_no_found: shootAfter,
    };
  }

  return { ok: true, written: true, dry_run: false, ...base };
}

export function registerRuminScriptTools(server: McpServer, env: Env): void {
  server.tool(
    "rumin_script__put_row",
    "るーみんの YouTube 台本台帳に、撮影番号（例：撮6）の行の「台本を開く」「状態」「決めてほしいこと」の 3 列だけを書く。行が無ければ末尾に 1 行足す（撮影番号も入れる）。ほかの列（期日・MTG で人が書く列）には書かない。状態はシートのプルダウンの値だけを受け付け、人が入れた状態を上書きするのは「先生確認待ち」にするときだけ（それ以外は書かずに warnings で返す）。渡さなかった列は触らない。dry_run=true なら書かずに、入れ先の行と書く前後の値だけを返す。",
    {
      shoot_no: z.string().describe("撮影番号。例：撮6"),
      script_url: z.string().optional().describe("台本を開く（台本の住所。https:// で始まる 1 本）"),
      status: z.string().optional().describe("状態（シートのプルダウンの値のどれか）"),
      ask: z.string().optional().describe("決めてほしいこと（短い文・300 文字まで）"),
      tab: z.string().optional().describe("タブの名前。省くと 4 つの見出しがそろうタブを探す"),
      dry_run: z.boolean().optional().describe("true なら書かずに、入れ先の行と書く前後の値だけを返す"),
    },
    async (args) => {
      const id = env.RUMIN_SCRIPT_SHEET_ID?.trim() ?? "";
      if (!id) {
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: "RUMIN_SCRIPT_SHEET_ID が入っていません（台本台帳の番号）",
        });
      }
      try {
        const token = await getGoogleTokenForScope(env, SCOPE);
        const sheets: SheetsJson = async <T>(url: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${token}`);
          if (init.body) headers.set("content-type", "application/json");
          const res = await fetch(url, { ...init, headers });
          if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${await res.text()}`);
          return (await res.json()) as T;
        };
        return asMcpTextResult(await putRuminScriptRow(sheets, id, args));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const noAccess = /Google Sheets (403|404)/.test(message);
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: noAccess
            ? "台本台帳を開けません。台帳を share_with のメールアドレスへ編集者で共有してください"
            : "Google への呼び出しで止まりました",
          share_with: noAccess ? env.FIREBASE_SA_EMAIL : undefined,
          error: message.slice(0, 500),
        });
      }
    }
  );
}
