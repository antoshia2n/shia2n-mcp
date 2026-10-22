/**
 * 案件シートを読む・足す（2026-10-22 開発部）。道具 anken__sheet_add_links と、案件くんの画面の受け口 /anken/sheet が同じものを使う。
 * 署名はシート用の既存のもの（スプレッドシートの範囲）。相手のシートにその宛先を編集者として共有しておく。
 */
import type { Env } from "./index.js";
import { getGoogleTokenForScope } from "./google-token.js";
import { planRows, readTab, NEW_TAB_HEADER, type Cell, type LinkItem, type SheetTab } from "./anken-sheet.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
type Row = Record<string, any>;

export function sheetIdOf(src: string | null | undefined): string {
  const s = String(src ?? "").trim();
  return (s.match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1] || (/^[\w-]{20,}$/.test(s) ? s : "");
}

async function client(env: Env, id: string) {
  const token = await getGoogleTokenForScope(env, SCOPE);
  return async (path: string, init: RequestInit = {}): Promise<Row> => {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sheets ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  };
}

const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const toCell = (v: Row): Cell => ({
  text: String(v?.formattedValue ?? ""),
  links: [v?.hyperlink, ...((v?.chipRuns || []) as Row[]).map((cr) => cr?.chip?.richLinkProperties?.uri)].filter(Boolean),
});

/** タブの中身をセルで読む（文字・リンク・チップ）。チップの欄が読めない版の API なら、文字とリンクだけで読み直す */
async function readGrid(api: (p: string) => Promise<Row>, ranges: string[]): Promise<Row[]> {
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const get = (fields: string) => api(`?${q}&fields=${encodeURIComponent(fields)}`);
  let grid: Row;
  try { grid = await get("sheets(properties.title,data.rowData.values(formattedValue,hyperlink,chipRuns))"); }
  catch { grid = await get("sheets(properties.title,data.rowData.values(formattedValue,hyperlink))"); }
  return grid.sheets || [];
}

/** シート全体を読む。タブの並びはシートの並びのまま */
export async function readSheet(env: Env, id: string): Promise<{ title: string; tabs: SheetTab[] }> {
  const api = await client(env, id);
  const meta = await api(`?fields=${encodeURIComponent("properties.title,sheets.properties.title")}`);
  const titles: string[] = (meta.sheets || []).map((s: Row) => s.properties?.title).filter(Boolean);
  if (!titles.length) return { title: meta.properties?.title ?? "", tabs: [] };
  const sheets = await readGrid(api, titles.map((t) => `${quote(t)}!A1:J3000`));
  const tabs = sheets.map((s: Row, i: number) => {
    const rowData: Row[] = s.data?.[0]?.rowData || [];
    return readTab(s.properties?.title ?? titles[i], rowData.map((r) => (r.values || []).map(toCell)));
  });
  return { title: meta.properties?.title ?? "", tabs };
}

/** 1 つのタブにリンクを足す（無いタブは作る・同じリンクは足さない・既にある行は書き換えない） */
export async function addLinks(env: Env, id: string, tab: string, items: LinkItem[], dryRun = false) {
  const api = await client(env, id);
  const meta = await api(`?fields=${encodeURIComponent("sheets.properties.title")}`);
  const titles: string[] = (meta.sheets || []).map((x: Row) => x.properties?.title);
  let created = false;
  let values: string[][] = [];
  if (!titles.includes(tab)) {
    if (!dryRun) {
      await api(":batchUpdate", { method: "POST", body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }) });
      await api(`/values/${encodeURIComponent(`${quote(tab)}!A1`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [NEW_TAB_HEADER] }) });
    }
    created = true;
    values = [NEW_TAB_HEADER];
  } else {
    const [s] = await readGrid(api, [`${quote(tab)}!A1:J3000`]);
    const rowData: Row[] = s?.data?.[0]?.rowData || [];
    values = rowData.map((r) => (r.values || []).map((v: Row) => { const c = toCell(v); return [c.text, ...c.links].filter(Boolean).join(" "); }));
  }
  const plan = planRows(values, items);
  if (!dryRun && plan.rows.length) {
    await api(`/values/${encodeURIComponent(`${quote(tab)}!A${plan.startRow}`)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: JSON.stringify({ values: plan.rows }) });
  }
  return { created, plan };
}
