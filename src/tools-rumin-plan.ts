import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";

/**
 * るーみんの YouTube「企画・制作シート」（Google スプレッドシート）を触る道具。
 * 命名規約：rumin_plan__<action>
 *
 * 2026-10-03 新設（v0.91.0・Naoki 依頼・るーみん案件）：rumin_plan__put_row
 *   ・毎週火曜に Claude が書き、木曜の MTG で先生とシアニンが手で書くシート。
 *     それまでは Claude がセルを書けず、Naoki が毎週ファイルを置き換えていた。その手をなくす口
 *   ・タブ名と、行を見分けるキー（列と値・1〜3 組）を受け取り、その行の指定した列だけを書く。
 *     キーが一致する行が無ければ末尾に 1 行足す（そのときだけキーの列も書く）。2 行以上なら書かない
 *   ・人が書く列には書かない（PROTECTED）。渡されたら 1 セルも書かずに止める。
 *     例外は採用・進行の「状態」を「シアニンレビュー待ち」「先生確認待ち」「修正中」にするときだけ
 *
 * 2026-10-03 v0.92.0：書いてよい「状態」に「シアニンレビュー待ち」を足した（Naoki 依頼・るーみん案件）。
 *   台本の流れが 下書き中 → シアニンレビュー待ち（Naoki が見て整える）→ 先生確認待ち に変わったため。
 *   Claude は書き上げた時点で「シアニンレビュー待ち」にする。値はシートのプルダウンにも入っている必要がある
 *
 * 2026-10-03 v0.93.0：シートのタブの作り直しに合わせて、書いてよいタブと守る列を差し替えた（Naoki 依頼・るーみん案件）。
 *   書けるのは ① ネタ帳・② 台本くらべ・③ 撮影〜公開・④ 公開テスト と、名前が「根拠｜」「記録｜」で始まるタブだけ（許す側の一覧）。
 *   それ以外（0 はじめに・消えた今週・企画案・採用・進行・ルール・今後足されるタブ）には書かない。
 *   タブは頭の番号を省いて渡してよい（「ネタ帳」で「① ネタ帳」に当たる）
 *   ・式が入っている列（例：次に動く人）には書かない。プルダウンの列は、プルダウンの値だけを受け付ける
 *   ・列は位置ではなく見出しの文字で探す。見出しの末尾の（…）は見ない（「公開日（木曜・仮）」＝「公開日」）
 *   ・書き方は RAW。「=」で始まる文も式にはならない
 *   ・シートの番号は RUMIN_PLAN_SHEET_ID（シークレット。置き場が公開なので vars には書かない）
 *   ・Google へは FIREBASE_SA_EMAIL の機械用の身分で入る。シートをそのメールアドレスへ編集者で共有する前提
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** 見出しを探す行の数（1 行目から数える） */
const HEADER_SCAN_ROWS = 5;
/** 1 セルに書く文字の上限 */
const MAX_VALUE_LENGTH = 5000;

/** タブ名の見分け：全角半角をそろえ、頭の番号（①・0 など）と空白を外し、波線をそろえる */
export function tabKey(name: string | undefined): string {
  return (name ?? "")
    .normalize("NFKC")
    .replace(/[〜～]/g, "~")
    .replace(/^\d+\s*/, "")
    .replace(/\s+/g, "");
}

/** 書いてよいタブ（tabKey で比べる）。ここに無いタブには書かない */
export const WRITABLE_TABS = ["ネタ帳", "台本くらべ", "撮影〜公開", "公開テスト"];
/** 名前がこれで始まるタブも書いてよい（裏づけデータ） */
export const WRITABLE_TAB_PREFIXES = ["根拠｜", "記録｜"];

export function isWritableTab(key: string): boolean {
  return WRITABLE_TABS.map((t) => tabKey(t)).includes(key) || WRITABLE_TAB_PREFIXES.some((p) => key.startsWith(tabKey(p)));
}

/** 人が書く列。タブ名 → 見出し（タブは tabKey、見出しは headKey で比べる） */
export const PROTECTED: Record<string, string[]> = {
  ネタ帳: ["判断"],
  台本くらべ: ["MTGの判断", "状態"],
  "撮影〜公開": ["状態", "公開予定日"],
  公開テスト: ["テスト結果"],
};

/** 人が書く列のうち、Claude が書いてよい値。タブ名 → 見出し → 値 */
export const PROTECTED_EXCEPTIONS: Record<string, Record<string, string[]>> = {
  台本くらべ: { 状態: ["下書き中", "シアニンレビュー待ち", "先生に共有"] },
};

function protectedList(key: string): string[] {
  return Object.entries(PROTECTED).find(([t]) => tabKey(t) === key)?.[1] ?? [];
}

function exceptionsFor(key: string): Record<string, string[]> {
  return Object.entries(PROTECTED_EXCEPTIONS).find(([t]) => tabKey(t) === key)?.[1] ?? {};
}

export type SheetsJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface ColumnValue {
  column: string;
  value: string;
}

export interface PutPlanRowInput {
  tab: string;
  keys: ColumnValue[];
  cells: ColumnValue[];
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

/** キーの値の見分け：全角半角をそろえ、空白を外す。日付は 2026/10/8 も 2026-10-08 も同じに見る */
export function keyValue(value: string | undefined): string {
  const v = (value ?? "").normalize("NFKC").replace(/\s+/g, "");
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return v;
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

/** 1〜HEADER_SCAN_ROWS 行目で、欲しい見出しがすべて 1 つずつそろう最初の行を探す */
export function findHeader(
  values: Cells,
  wanted: string[]
): { headerRow: number; columns: Record<string, number> } | { error: string } {
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, values.length); r++) {
    const keys = (values[r] ?? []).map((cell) => headKey(cell));
    const positions = wanted.map((w) => keys.flatMap((k, i) => (k === w ? [i] : [])));
    if (positions.every((p) => p.length >= 1)) {
      const dup = wanted.filter((_, i) => positions[i].length > 1);
      if (dup.length > 0) return { error: `見出し ${dup.join("・")} が同じ行に 2 つ以上あります（${r + 1} 行目）` };
      const columns: Record<string, number> = {};
      wanted.forEach((w, i) => (columns[w] = positions[i][0]));
      return { headerRow: r + 1, columns };
    }
  }
  const first = (values[0] ?? []).map((cell) => headKey(cell)).filter((k) => k !== "");
  const missing = wanted.filter((w) => !first.includes(w));
  return {
    error: `1〜${HEADER_SCAN_ROWS} 行目に、見出し ${wanted.join("・")} がそろう行がありません（1 行目に無いもの：${missing.join("・") || "なし"}）`,
  };
}

/** 値が入っている最後の行の番号（1 始まり）。空なら 0 */
export function lastFilledRow(values: Cells): number {
  for (let r = values.length - 1; r >= 0; r--) {
    if ((values[r] ?? []).some((cell) => (cell ?? "").trim() !== "")) return r + 1;
  }
  return 0;
}

/** 人が書く列か。書いてよい例外の値なら false */
export function isProtected(tab: string, column: string, value: string): boolean {
  const list = protectedList(tab).map((c) => headKey(c));
  if (!list.includes(column)) return false;
  const allowed = Object.entries(exceptionsFor(tab)).find(([c]) => headKey(c) === column)?.[1] ?? [];
  return !allowed.includes(value);
}

type Validation = { condition?: { type?: string; values?: { userEnteredValue?: string }[] } };
type GridResponse = {
  sheets?: {
    data?: { startColumn?: number; rowData?: { values?: { dataValidation?: Validation }[] }[] }[];
  }[];
};

/** 列ごとのプルダウンの値を、シートから読む。ONE_OF_LIST と ONE_OF_RANGE の 2 種だけを見る。プルダウンの無い列は返さない */
async function readDropdowns(
  sheets: SheetsJson,
  id: string,
  tab: string,
  columns: number[],
  fromRow: number,
  toRow: number
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (columns.length === 0) return out;
  const ranges = columns.map((c) => `${quoteTab(tab)}!${columnLetter(c)}${fromRow}:${columnLetter(c)}${toRow}`);
  const grid = await sheets<GridResponse>(
    `${API}/${id}?${ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&")}&fields=${encodeURIComponent(
      "sheets(data(startColumn,rowData(values(dataValidation))))"
    )}`
  );
  // 範囲ごとの塊は startColumn で列へ結びつける（返る順に頼らない）
  const datas = grid.sheets?.[0]?.data ?? [];
  for (let i = 0; i < columns.length; i++) {
    const options = new Set<string>();
    const rangeRefs = new Set<string>();
    const data = datas.find((d) => (d.startColumn ?? 0) === columns[i]);
    for (const row of data?.rowData ?? []) {
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
    for (const ref of rangeRefs) {
      const got = await sheets<{ values?: Cells }>(`${API}/${id}/values/${encodeURIComponent(ref)}`);
      for (const row of got.values ?? []) {
        for (const cell of row) {
          const text = (cell ?? "").trim();
          if (text) options.add(text);
        }
      }
    }
    if (options.size > 0 || rangeRefs.size > 0) out.set(columns[i], [...options]);
  }
  return out;
}

/**
 * 口の中身。Google への呼び出しは sheets に寄せてあるので、偽物を渡せば手元で通しで確かめられる。
 */
export async function putRuminPlanRow(
  sheets: SheetsJson,
  id: string,
  input: PutPlanRowInput
): Promise<Record<string, unknown>> {
  const asked = (input.tab ?? "").trim();
  // tab は守る列を引くための見分けの名前。シートの実際の名前は sheetTitle（タブがあると分かってから決まる）
  const tab = tabKey(asked);
  let sheetTitle = asked;
  const keys = (input.keys ?? []).map((k) => ({ column: headKey(k.column), value: (k.value ?? "").trim() }));
  const cells = (input.cells ?? []).map((c) => ({ column: headKey(c.column), value: (c.value ?? "").trim() }));
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    written: false,
    reason,
    tab: sheetTitle,
    ...extra,
  });

  // ── 受け付ける形か（ここで止まったら Google には 1 回も触らない）
  if (!tab) return refuse("tab（タブの名前）が空です。書きませんでした");
  if (!isWritableTab(tab)) {
    return refuse(
      `タブ「${asked}」はこの口では書きません。書けるのは ${WRITABLE_TABS.join("・")} と、名前が ${WRITABLE_TAB_PREFIXES.join("・")} で始まるタブだけです。書きませんでした`
    );
  }
  if (keys.length < 1 || keys.length > 3) return refuse("keys は 1〜3 組で渡してください。書きませんでした");
  if (cells.length < 1 || cells.length > 20) return refuse("cells は 1〜20 組で渡してください。書きませんでした");
  if (keys.some((k) => !k.column || !k.value)) return refuse("keys の列と値は空にできません。書きませんでした");
  if (cells.some((c) => !c.column)) return refuse("cells の列は空にできません。書きませんでした");
  const allCols = [...keys.map((k) => k.column), ...cells.map((c) => c.column)];
  const dupCols = allCols.filter((c, i) => allCols.indexOf(c) !== i);
  if (dupCols.length > 0) {
    return refuse(`列 ${[...new Set(dupCols)].join("・")} が 2 回以上出ています（キーの列は cells に入れない）。書きませんでした`);
  }
  const tooLong = [...keys, ...cells].filter((x) => x.value.length > MAX_VALUE_LENGTH);
  if (tooLong.length > 0) {
    return refuse(`${MAX_VALUE_LENGTH} 文字を超える値があります（${tooLong.map((x) => x.column).join("・")}）。書きませんでした`);
  }
  const blocked = cells.filter((c) => isProtected(tab, c.column, c.value));
  if (blocked.length > 0) {
    const allowedNote = Object.entries(exceptionsFor(tab))
      .map(([col, vals]) => `「${col}」を ${vals.map((v) => `「${v}」`).join("・")} にするときだけ`)
      .join("、");
    return refuse(
      `人が書く列 ${blocked.map((c) => `「${c.column}」`).join("・")} が入っています。1 セルも書きませんでした${allowedNote ? `（書いてよいのは${allowedNote}）` : ""}`,
      { protected_columns: protectedList(tab) }
    );
  }

  // ── タブがあるか
  const meta = await sheets<{ sheets?: { properties?: { title?: string } }[] }>(
    `${API}/${id}?fields=${encodeURIComponent("sheets.properties.title")}`
  );
  const allTabs = (meta.sheets ?? []).map((s) => s.properties?.title ?? "").filter((t) => t !== "");
  const hits = allTabs.filter((t) => tabKey(t) === tab);
  if (hits.length !== 1) {
    return refuse(
      hits.length === 0
        ? `タブ「${asked}」がありません。書きませんでした`
        : `タブ「${asked}」に当たるタブが ${hits.length} つあります（${hits.join("・")}）。書きませんでした`,
      { tabs: allTabs }
    );
  }
  sheetTitle = hits[0];

  // ── 中身を 2 通りで読む（見えている文字と、式）
  const range = encodeURIComponent(quoteTab(sheetTitle));
  const shown = await sheets<{ values?: Cells }>(`${API}/${id}/values/${range}?majorDimension=ROWS`);
  const formulas = await sheets<{ values?: Cells }>(
    `${API}/${id}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMULA`
  );
  const values = shown.values ?? [];
  const fvalues = formulas.values ?? [];

  const header = findHeader(values, allCols);
  if ("error" in header) return refuse(`${header.error}。書きませんでした`);
  const col = header.columns;

  // ── どの行か：キーがすべて一致する行がちょうど 1 つならその行。0 なら末尾に足す。2 つ以上なら止める
  const matched: number[] = [];
  for (let r = header.headerRow; r < values.length; r++) {
    if (keys.every((k) => keyValue(values[r]?.[col[k.column]]) === keyValue(k.value))) matched.push(r + 1);
  }
  const keyText = keys.map((k) => `${k.column}=${k.value}`).join("・");
  if (matched.length > 1) {
    return refuse(
      `キー（${keyText}）に当たる行が ${matched.length} 行あります（${matched.join("・")} 行目）。キーの列を足して 1 行にしぼってください。書きませんでした`
    );
  }
  const adding = matched.length === 0;
  const lastRow = Math.max(lastFilledRow(values), header.headerRow);
  const rowNo = adding ? lastRow + 1 : matched[0];
  if (adding) {
    const protectedKeys = keys.filter((k) => protectedList(tab).map((c) => headKey(c)).includes(k.column));
    if (protectedKeys.length > 0) {
      return refuse(
        `キー（${keyText}）の行が無く、足すと人が書く列 ${protectedKeys.map((k) => `「${k.column}」`).join("・")} に書くことになります。書きませんでした`
      );
    }
  }

  // ── 式の列には書かない（その列のどこかの行に式があれば、式の列とみなす）
  const writeCols = adding ? allCols : cells.map((c) => c.column);
  const formulaCols = writeCols.filter((c) => {
    for (let r = header.headerRow; r < fvalues.length; r++) {
      if ((fvalues[r]?.[col[c]] ?? "").startsWith("=")) return true;
    }
    return false;
  });
  if (formulaCols.length > 0) {
    return refuse(`式の入っている列 ${formulaCols.map((c) => `「${c}」`).join("・")} には書きません。書きませんでした`, {
      row_no: rowNo,
    });
  }

  // ── プルダウンの列は、プルダウンの値だけ（空にするのは受け付ける）
  const dropdowns = await readDropdowns(
    sheets,
    id,
    sheetTitle,
    writeCols.map((c) => col[c]),
    header.headerRow + 1,
    Math.max(lastRow, rowNo, header.headerRow + 1)
  );
  const writes = adding ? [...keys, ...cells] : cells;
  const badChoice = writes.filter((w) => {
    const options = dropdowns.get(col[w.column]);
    return options !== undefined && w.value !== "" && !options.includes(w.value);
  });
  if (badChoice.length > 0) {
    return refuse(
      `プルダウンに無い値があります（${badChoice.map((w) => `${w.column}「${w.value}」`).join("・")}）。書きませんでした`,
      {
        row_no: rowNo,
        options: Object.fromEntries(badChoice.map((w) => [w.column, dropdowns.get(col[w.column]) ?? []])),
      }
    );
  }

  // ── 書く中身を決める（変わるセルだけ）
  const rowNow = adding ? [] : values[rowNo - 1] ?? [];
  const before: Record<string, string> = {};
  for (const c of cells) before[c.column] = (rowNow[col[c.column]] ?? "").trim();
  const updates = writes.filter((w) => adding || w.value !== (rowNow[col[w.column]] ?? "").trim());
  const after: Record<string, string> = { ...before };
  for (const u of updates) if (u.column in after) after[u.column] = u.value;
  const base = {
    tab: sheetTitle,
    row_no: rowNo,
    keys: Object.fromEntries(keys.map((k) => [k.column, k.value])),
    action: updates.length === 0 ? "unchanged" : adding ? "added" : "updated",
    before,
    after,
    changed: updates.filter((u) => u.column in before).map((u) => u.column),
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
        range: `${quoteTab(sheetTitle)}!${columnLetter(col[u.column])}${rowNo}`,
        values: [[u.value]],
      })),
    }),
  });

  // ── 書いたあとに同じ行を読み直す。書いたセルが書いた値か・キーがずれていないか
  const reread = await sheets<{ values?: Cells }>(
    `${API}/${id}/values/${encodeURIComponent(`${quoteTab(sheetTitle)}!${rowNo}:${rowNo}`)}`
  );
  const rowAfter = reread.values?.[0] ?? [];
  const mismatched = updates.filter((u) => (rowAfter[col[u.column]] ?? "").trim() !== u.value);
  const keyMoved = keys.filter((k) => keyValue(rowAfter[col[k.column]]) !== keyValue(k.value));
  if (mismatched.length > 0 || keyMoved.length > 0) {
    return {
      ok: false,
      written: true,
      reason: "書いたあとに読み直すと、行の中身が合いません。人が同時にこの行を触った可能性があります",
      ...base,
      mismatched: mismatched.map((u) => ({
        column: u.column,
        wrote: u.value,
        found: (rowAfter[col[u.column]] ?? "").trim(),
      })),
      keys_moved: keyMoved.map((k) => k.column),
    };
  }

  return { ok: true, written: true, dry_run: false, ...base };
}

export function registerRuminPlanTools(server: McpServer, env: Env): void {
  const pair = z.object({
    column: z.string().describe("列の見出し。末尾の（…）は省いてよい。例：番号・ネタ番号・リンク・状態"),
    value: z.string().describe("値"),
  });
  server.tool(
    "rumin_plan__put_row",
    "るーみんの YouTube 企画・制作シートで、tab の中から keys（列と値・1〜3 組）がすべて一致する行を探し、cells に渡した列だけを書き換える。行が無ければ末尾に 1 行足す（そのときだけキーの列も書く）。一致が 2 行以上なら書かない（キーを足してしぼる）。書けるタブは ネタ帳・台本くらべ・撮影〜公開・公開テスト と、名前が 根拠｜・記録｜ で始まるタブだけ（頭の番号 ①〜④ は省いてよい）。キーの例：ネタ帳は 番号（N-01）、台本くらべは ネタ番号、撮影〜公開は タイトル、公開テストは 公開日。人が書く列（ネタ帳の 判断／台本くらべの MTGの判断／撮影〜公開の 状態・公開予定日／公開テストの テスト結果）が cells に入っていたら 1 セルも書かない。台本くらべの 状態 は 下書き中・シアニンレビュー待ち・先生に共有 のどれかにするときだけ書ける（台本を書き上げたら シアニンレビュー待ち。先生に共有 にするのは Naoki のレビュー後）。式の入った列（次に動く人など）にも書かない。プルダウンの列はプルダウンの値だけ。dry_run=true なら書かずに、入れ先の行と書く前後の値だけを返す。",
    {
      tab: z.string().describe("タブの名前。頭の番号は省いてよい。例：ネタ帳・台本くらべ・撮影〜公開・公開テスト・根拠｜テーマ候補"),
      keys: z.array(pair).describe("行を見分けるキー（1〜3 組）。例：[{column:\"ネタ番号\",value:\"N-01\"}]"),
      cells: z.array(pair).describe("書く列と値（1〜20 組）。キーの列は入れない。空文字はそのセルを空にする"),
      dry_run: z.boolean().optional().describe("true なら書かずに、入れ先の行と書く前後の値だけを返す"),
    },
    async (args) => {
      const id = env.RUMIN_PLAN_SHEET_ID?.trim() ?? "";
      if (!id) {
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: "RUMIN_PLAN_SHEET_ID が入っていません（企画・制作シートの番号）",
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
        return asMcpTextResult(await putRuminPlanRow(sheets, id, args));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const noAccess = /Google Sheets (403|404)/.test(message);
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: noAccess
            ? "企画・制作シートを開けません。シートを share_with のメールアドレスへ編集者で共有してください"
            : "Google への呼び出しで止まりました",
          share_with: noAccess ? env.FIREBASE_SA_EMAIL : undefined,
          error: message.slice(0, 500),
        });
      }
    }
  );
}
