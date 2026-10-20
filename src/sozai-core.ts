/**
 * 素材の一覧（Google スプレッドシート）に行を足す中身（2026-10-20 新設・v1.22.0）。
 * Google への呼び出しは sheets / drive に寄せてあるので、偽物を渡せば手元で通しで確かめられる。
 *
 * 決まり（Naoki 確定 2026-10-20「素材の受け箱と毎朝の振り分け」）：
 *   ・足すだけ。すでにある行は書き換えない・消さない
 *   ・同じ住所の行がすでにあれば足さない（二重に足さない）
 *   ・種類は 5 つ・使う場面は 5 語だけ。数字は実績だけ、掲載の許可は生徒の声だけ（空なら「未確認」）
 *   ・列は位置ではなく見出しの文字で探す。書き方は RAW（「=」で始まる文も式にならない）
 */

export type SheetsJson = <T>(url: string, init?: RequestInit) => Promise<T>;
type Cells = string[][];

export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

export const SHEET_NAME = "素材の一覧";
export const KINDS = ["実績", "生徒の声", "お手本", "セミナー資料", "自分の写真・図解"] as const;
export const SCENES = ["セミナー", "X記事", "note", "告知", "コンサル資料"] as const;
export const HEADERS = [
  "振り分けた日",
  "種類",
  "名前",
  "何が写っているか",
  "数字",
  "使う場面",
  "タグ",
  "掲載の許可",
  "住所",
  "元の名前",
] as const;
export type Header = (typeof HEADERS)[number];
export type SozaiRow = Partial<Record<Header, string>>;

const MAX_ROWS = 30;
const MAX_VALUE_LENGTH = 2000;
const HEADER_SCAN_ROWS = 5;
const PERMISSIONS = ["未確認", "あり", "なし"];

const norm = (v: string | undefined) => (v ?? "").normalize("NFKC").replace(/\s+/g, "");
const clean = (v: string | undefined) => (v ?? "").trim();

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

/** 使う場面・タグは「、」「,」「/」「／」区切りを受ける。並びは保つ・重なりは外す */
export function splitList(v: string | undefined): string[] {
  return [...new Set(clean(v).split(/[、,，/／・]\s*/).map((s) => s.trim()).filter(Boolean))];
}

/** 住所の見分け（末尾の ?usp=… や / の違いを同じに見る） */
export function addrKey(v: string | undefined): string {
  const s = clean(v);
  const m = s.match(/\/(?:d|folders)\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return s.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/** 1 行を確かめて、書く形にそろえる。だめなら理由を返す */
export function checkRow(input: SozaiRow): { row: Record<Header, string> } | { error: string } {
  const row = Object.fromEntries(HEADERS.map((h) => [h, clean(input[h])])) as Record<Header, string>;
  const unknown = Object.keys(input).filter((k) => !(HEADERS as readonly string[]).includes(k));
  if (unknown.length) return { error: `知らない列 ${unknown.join("・")} があります（列は ${HEADERS.join("・")}）` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.振り分けた日)) return { error: "振り分けた日は YYYY-MM-DD で渡してください" };
  if (!(KINDS as readonly string[]).includes(row.種類)) return { error: `種類は ${KINDS.join("・")} のどれかです（渡された値：「${row.種類}」）` };
  if (!row.名前) return { error: "名前が空です" };
  if (!row.何が写っているか) return { error: "何が写っているかが空です" };
  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(row.住所)) return { error: "住所は https://drive.google.com/… か https://docs.google.com/… で渡してください" };
  const scenes = splitList(row.使う場面);
  if (scenes.length === 0) return { error: `使う場面を 1 つ以上入れてください（${SCENES.join("・")}）` };
  const badScenes = scenes.filter((s) => !(SCENES as readonly string[]).includes(s));
  if (badScenes.length) return { error: `使う場面は ${SCENES.join("・")} だけです（使えない語：${badScenes.join("・")}）` };
  row.使う場面 = scenes.join("、");
  row.タグ = splitList(row.タグ).join("、");
  if (row.種類 !== "実績" && row.数字) return { error: "数字は種類が実績のときだけ入れます" };
  if (row.種類 === "生徒の声") {
    if (!row.掲載の許可) row.掲載の許可 = "未確認";
    if (!PERMISSIONS.includes(row.掲載の許可)) return { error: `掲載の許可は ${PERMISSIONS.join("・")} のどれかです` };
  } else if (row.掲載の許可) {
    return { error: "掲載の許可は種類が生徒の声のときだけ入れます" };
  }
  const tooLong = HEADERS.filter((h) => row[h].length > MAX_VALUE_LENGTH);
  if (tooLong.length) return { error: `${MAX_VALUE_LENGTH} 字を超える列があります（${tooLong.join("・")}）` };
  return { row };
}

/** 1〜5 行目で、10 の見出しがすべてそろう最初の行を探す */
export function findHeader(values: Cells): { headerRow: number; columns: Record<Header, number> } | { error: string } {
  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, values.length); r++) {
    const keys = (values[r] ?? []).map((c) => norm(c));
    const cols: Partial<Record<Header, number>> = {};
    let ok = true;
    for (const h of HEADERS) {
      const hits = keys.flatMap((k, i) => (k === norm(h) ? [i] : []));
      if (hits.length !== 1) {
        ok = false;
        break;
      }
      cols[h] = hits[0];
    }
    if (ok) return { headerRow: r + 1, columns: cols as Record<Header, number> };
  }
  return { error: `1〜${HEADER_SCAN_ROWS} 行目に、見出し ${HEADERS.join("・")} がそろう行がありません` };
}

export function lastFilledRow(values: Cells): number {
  for (let r = values.length - 1; r >= 0; r--) {
    if ((values[r] ?? []).some((c) => clean(c) !== "")) return r + 1;
  }
  return 0;
}

/** 表の番号を決める。設定があればそれ、無ければ機械用の身分に共有された「素材の一覧」を名前で探す */
export async function resolveSheetId(drive: SheetsJson, configured: string | undefined): Promise<{ id: string } | { error: string }> {
  if (clean(configured)) return { id: clean(configured) };
  const q = `name = '${SHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const got = await drive<{ files?: { id?: string; name?: string }[] }>(
    `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name)")}&pageSize=10`
  );
  const files = (got.files ?? []).filter((f) => f.id);
  if (files.length === 1) return { id: files[0].id as string };
  if (files.length === 0) return { error: `「${SHEET_NAME}」が見つかりません。表を share_with のメールアドレスへ編集者で共有してください` };
  return { error: `「${SHEET_NAME}」という名前の表が ${files.length} つ見えます。1 つにしてください` };
}

export interface PutSozaiInput {
  rows: SozaiRow[];
  dry_run?: boolean;
}

export async function putSozaiRows(sheets: SheetsJson, id: string, input: PutSozaiInput): Promise<Record<string, unknown>> {
  const rows = input.rows ?? [];
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => ({ ok: false, written: false, reason, ...extra });

  // ── 受け付ける形か（ここで止まったら Google には 1 回も触らない）
  if (rows.length < 1 || rows.length > MAX_ROWS) return refuse(`rows は 1〜${MAX_ROWS} 行で渡してください。書きませんでした`);
  const checked: Record<Header, string>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const c = checkRow(rows[i]);
    if ("error" in c) return refuse(`${i + 1} 行目：${c.error}。1 行も書きませんでした`);
    checked.push(c.row);
  }
  const seen = new Set<string>();
  for (let i = 0; i < checked.length; i++) {
    const k = addrKey(checked[i].住所);
    if (seen.has(k)) return refuse(`${i + 1} 行目：同じ住所が rows の中に 2 回あります。1 行も書きませんでした`);
    seen.add(k);
  }

  // ── 最初のタブを読む
  const meta = await sheets<{ sheets?: { properties?: { title?: string } }[] }>(
    `${SHEETS_API}/${id}?fields=${encodeURIComponent("sheets.properties.title")}`
  );
  const tab = meta.sheets?.[0]?.properties?.title ?? "";
  if (!tab) return refuse("表にタブがありません。書きませんでした");
  const got = await sheets<{ values?: Cells }>(`${SHEETS_API}/${id}/values/${encodeURIComponent(quoteTab(tab))}?majorDimension=ROWS`);
  const values = got.values ?? [];
  const header = findHeader(values);
  if ("error" in header) return refuse(`${header.error}。書きませんでした`, { tab });
  const col = header.columns;

  // ── 同じ住所の行がすでにあれば足さない
  const existing = new Set<string>();
  for (let r = header.headerRow; r < values.length; r++) {
    const k = addrKey(values[r]?.[col.住所]);
    if (k) existing.add(k);
  }
  const toAdd = checked.filter((r) => !existing.has(addrKey(r.住所)));
  const skipped = checked.filter((r) => existing.has(addrKey(r.住所))).map((r) => ({ 名前: r.名前, 住所: r.住所, reason: "同じ住所の行がすでにあります" }));
  const start = Math.max(lastFilledRow(values), header.headerRow) + 1;
  const plan = toAdd.map((r, i) => ({ row_no: start + i, 名前: r.名前, 種類: r.種類 }));

  if (toAdd.length === 0 || input.dry_run === true) {
    return { ok: true, written: false, dry_run: input.dry_run === true, tab, added: plan, skipped };
  }

  // ── 書く（足す行のセルだけ。RAW）
  const data = toAdd.flatMap((r, i) =>
    HEADERS.filter((h) => r[h] !== "").map((h) => ({
      range: `${quoteTab(tab)}!${columnLetter(col[h])}${start + i}`,
      values: [[r[h]]],
    }))
  );
  await sheets(`${SHEETS_API}/${id}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  });

  // ── 読み直して、書いた値か確かめる
  const reread = await sheets<{ values?: Cells }>(
    `${SHEETS_API}/${id}/values/${encodeURIComponent(`${quoteTab(tab)}!${start}:${start + toAdd.length - 1}`)}`
  );
  const after = reread.values ?? [];
  const mismatched = toAdd.flatMap((r, i) =>
    HEADERS.filter((h) => clean(after[i]?.[col[h]]) !== r[h]).map((h) => ({ row_no: start + i, column: h, wrote: r[h], found: clean(after[i]?.[col[h]]) }))
  );
  if (mismatched.length > 0) {
    return { ok: false, written: true, reason: "書いたあとに読み直すと、中身が合いません。人が同時に表を触った可能性があります", tab, added: plan, skipped, mismatched };
  }
  return { ok: true, written: true, dry_run: false, tab, added: plan, skipped };
}

// ── 画像を見る（2026-10-20 追加・v1.23.0）
// Google ドライブの道具の read_file_content は画像の文字しか返さず、文字が拾えない画面写真は空で返る。
// 振り分けが画面写真の中身を見て種類を決められるよう、機械用の身分で画像そのものを取って渡す。

export const LOOK_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const LOOK_MAX_BYTES = 4_500_000;

export interface DriveMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
}

/** 見せてよい画像か。だめなら理由を返す */
export function checkLook(meta: DriveMeta): { ok: true } | { error: string } {
  if (!meta.id) return { error: "ファイルが見つかりません" };
  if (!(LOOK_TYPES as readonly string[]).includes(meta.mimeType ?? "")) {
    return { error: `画像（${LOOK_TYPES.join("・")}）だけを見られます（このファイルは ${meta.mimeType ?? "不明"}）` };
  }
  const size = Number(meta.size ?? "0");
  if (!Number.isFinite(size) || size <= 0) return { error: "大きさが読めないファイルです" };
  if (size > LOOK_MAX_BYTES) return { error: `大きすぎます（${size} バイト。上限 ${LOOK_MAX_BYTES} バイト）` };
  return { ok: true };
}

/** バイト列を base64 に（Workers には Buffer が無いので btoa を小分けに使う） */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
