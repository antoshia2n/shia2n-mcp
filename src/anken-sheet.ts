/**
 * 案件くん → 案件シート（2026-10-22 開発部・Naoki「全データは案件シートに格納しつつ、案件くんから整理された状態でアクセスしたい」）。
 *
 *   ・正本は案件シート（例：るーみん案件データ管理）。タブは案件くんのプロジェクトにそろえる。
 *   ・ここは「どの行・どの列に何を書くか」を決めるだけ（シートを呼ぶのは tools-anken.ts の anken__sheet_add_links）。
 *   ・列は見出しで見分ける：名前（名称）・リンク・詳細。見出しの無いタブ（例：タスク）は B＝詳細・C＝リンク（いまの行の形）。
 *   ・新しいタブの見出しは A 空き・B 名前・C リンク・D 詳細（YouTube のタブと同じ形）。
 *   ・同じリンクが既にあるタブには足さない。名前と詳細は文字のまま入るように先頭に ' を付ける（日付や数に化けないため）。
 */

export const NEW_TAB_HEADER = ["", "名前", "リンク", "詳細"];

type Cells = string[][];

export interface LinkItem {
  name: string;
  url: string;
  detail?: string;
  /** 「ジャンル」の見出しがあるタブだけに入る */
  group?: string;
}

const norm = (v: string | undefined) => (v ?? "").normalize("NFKC").replace(/\s+/g, "");

/** 同じリンクかを見る鍵。Google のファイルは番号だけ（/edit や ?usp= の違いを無視する）。ほかは末尾の / を外した住所 */
export function linkKey(url: string): string {
  const g = url.match(/(?:docs|drive)\.google\.com\/.*?(?:\/d\/|\/folders\/|[?&]id=)([\w-]{20,})/);
  if (g) return `g:${g[1]}`;
  return url.trim().replace(/\/+$/, "");
}

/** 1〜5 行目で「リンク」の見出しがある行を探し、名前（名称）・リンク・詳細の列を返す。無ければ見出しなしの形 */
export function findColumns(values: Cells): { headerRow: number; name: number | null; link: number; detail: number | null; group: number | null } {
  for (let r = 0; r < Math.min(5, values.length); r++) {
    const keys = (values[r] ?? []).map(norm);
    const link = keys.indexOf("リンク");
    if (link < 0) continue;
    const name = keys.findIndex((k) => k === "名前" || k === "名称");
    const detail = keys.indexOf("詳細");
    const group = keys.indexOf("ジャンル");
    return { headerRow: r + 1, name: name < 0 ? null : name, link, detail: detail < 0 ? null : detail, group: group < 0 ? null : group };
  }
  return { headerRow: 0, name: null, link: 2, detail: 1, group: null };
}

export function lastFilledRow(values: Cells): number {
  for (let r = values.length - 1; r >= 0; r--) if ((values[r] ?? []).some((c) => (c ?? "").trim() !== "")) return r + 1;
  return 0;
}

const asText = (v: string) => (v ? `'${v}` : "");

/** 足す行を組む。戻り値の rows は A 列から並べた値（startRow 行目から下へ書く） */
export function planRows(values: Cells, items: LinkItem[]): { startRow: number; width: number; rows: string[][]; skipped: { name: string; reason: string }[] } {
  const cols = findColumns(values);
  const have = new Set<string>();
  for (const row of values) for (const cell of row ?? []) for (const m of String(cell ?? "").matchAll(/https?:\/\/[^\s"']+/g)) have.add(linkKey(m[0]));
  const width = Math.max(cols.link, cols.name ?? 0, cols.detail ?? 0, cols.group ?? 0) + 1;
  const rows: string[][] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const it of items) {
    const url = it.url.trim();
    if (have.has(linkKey(url))) { skipped.push({ name: it.name, reason: "同じリンクがこのタブにある" }); continue; }
    have.add(linkKey(url));
    const row = Array(width).fill("");
    row[cols.link] = url;
    if (cols.name !== null) row[cols.name] = asText(it.name);
    const detail = cols.name === null ? [it.name, it.detail].filter(Boolean).join("｜") : it.detail ?? "";
    if (cols.detail !== null) row[cols.detail] = asText(detail);
    if (cols.group !== null && it.group) row[cols.group] = asText(it.group);
    rows.push(row);
  }
  return { startRow: Math.max(lastFilledRow(values), cols.headerRow) + 1, width, rows, skipped };
}
