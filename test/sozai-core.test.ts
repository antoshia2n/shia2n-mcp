import test from "node:test";
import assert from "node:assert/strict";
import { HEADERS, addrKey, checkRow, putSozaiRows, resolveSheetId, splitList, type SheetsJson } from "../src/sozai-core.ts";

/** 偽の表：1 タブ・値の配列。values:batchUpdate で書き、values/ で読む */
function fakeSheet(initial: string[][]) {
  const grid: string[][] = initial.map((r) => [...r]);
  const calls: string[] = [];
  const colIndex = (letters: string) => letters.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const sheets: SheetsJson = async <T>(url: string, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${decodeURIComponent(url)}`);
    if (url.includes("fields=sheets.properties.title")) return { sheets: [{ properties: { title: "シート1" } }] } as T;
    if (url.endsWith("values:batchUpdate")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.valueInputOption, "RAW");
      for (const d of body.data) {
        const m = String(d.range).match(/!([A-Z]+)(\d+)$/);
        assert.ok(m);
        const c = colIndex(m![1]), r = Number(m![2]) - 1;
        while (grid.length <= r) grid.push([]);
        while (grid[r].length <= c) grid[r].push("");
        grid[r][c] = d.values[0][0];
      }
      return {} as T;
    }
    const range = decodeURIComponent(url.split("/values/")[1] ?? "").split("?")[0];
    const rm = range.match(/!(\d+):(\d+)$/);
    if (rm) return { values: grid.slice(Number(rm[1]) - 1, Number(rm[2])) } as T;
    return { values: grid } as T;
  };
  return { sheets, grid, calls };
}

const head = [...HEADERS];
const good = (over: Record<string, string> = {}) => ({
  振り分けた日: "2026-10-21",
  種類: "実績",
  名前: "2026-10-21_実績_X記事インプ120万.png",
  何が写っているか: "X 記事のアナリティクスの画面。インプレッション 120 万。",
  数字: "X記事インプ：120万（2026-10-20 時点）",
  使う場面: "セミナー、告知",
  タグ: "X記事, インプレッション",
  住所: "https://drive.google.com/file/d/1AbcdefGhijkLMNOP/view?usp=drivesdk",
  元の名前: "スクリーンショット 2026-10-20.png",
  ...over,
});

test("1 行を確かめる：使う場面とタグは「、」にそろう・重なりは外す", () => {
  const c = checkRow(good({ 使う場面: "セミナー／告知、セミナー" }));
  assert.ok("row" in c);
  if ("row" in c) {
    assert.equal(c.row.使う場面, "セミナー、告知");
    assert.equal(c.row.タグ, "X記事、インプレッション");
  }
  assert.deepEqual(splitList("a、b,c／d"), ["a", "b", "c", "d"]);
});

test("断る形：種類・使う場面・数字・掲載の許可・住所・日付・知らない列", () => {
  const err = (o: Record<string, string>) => {
    const c = checkRow(good(o));
    return "error" in c ? c.error : "";
  };
  assert.match(err({ 種類: "メモ" }), /種類は/);
  assert.match(err({ 使う場面: "YouTube" }), /使う場面は/);
  assert.match(err({ 使う場面: "" }), /1 つ以上/);
  assert.match(err({ 種類: "お手本" }), /数字は種類が実績/);
  assert.match(err({ 掲載の許可: "あり" }), /生徒の声のときだけ/);
  assert.match(err({ 住所: "https://example.com/a" }), /住所は/);
  assert.match(err({ 振り分けた日: "10/21" }), /YYYY-MM-DD/);
  assert.match(err({ 何が写っているか: "" }), /何が写っているか/);
  const c = checkRow({ ...good(), 余計: "x" } as never);
  assert.ok("error" in c && /知らない列/.test(c.error));
});

test("生徒の声：掲載の許可は空なら未確認", () => {
  const c = checkRow(good({ 種類: "生徒の声", 数字: "" }));
  assert.ok("row" in c && c.row.掲載の許可 === "未確認");
  const d = checkRow(good({ 種類: "生徒の声", 数字: "", 掲載の許可: "たぶん" }));
  assert.ok("error" in d);
});

test("住所の見分け：?usp や末尾の違いを同じに見る", () => {
  assert.equal(addrKey("https://drive.google.com/file/d/1AbcdefGhijkLMNOP/view?usp=drivesdk"), addrKey("https://drive.google.com/file/d/1AbcdefGhijkLMNOP/view"));
});

test("足す：見出しの次の空いた行から・書いたら読み直して合う", async () => {
  const f = fakeSheet([head, ["2026-10-20", "お手本", "x", "y", "", "X記事", "", "", "https://drive.google.com/file/d/1ZZZZZZZZZZZ/view", ""]]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good(), good({ 種類: "生徒の声", 数字: "", 住所: "https://drive.google.com/file/d/1BBBBBBBBBBB/view", 名前: "n2" })] });
  assert.equal(r.ok, true);
  assert.equal(r.written, true);
  assert.deepEqual((r.added as { row_no: number }[]).map((a) => a.row_no), [3, 4]);
  assert.equal(f.grid[2][1], "実績");
  assert.equal(f.grid[2][5], "セミナー、告知");
  assert.equal(f.grid[3][7], "未確認");
  assert.equal(f.grid[1][2], "x", "すでにある行は触らない");
});

test("同じ住所の行があれば足さない（skipped）", async () => {
  const f = fakeSheet([head, ["2026-10-20", "実績", "old", "y", "", "X記事", "", "", "https://drive.google.com/file/d/1AbcdefGhijkLMNOP/view", ""]]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good()] });
  assert.equal(r.written, false);
  assert.equal((r.skipped as unknown[]).length, 1);
  assert.equal(f.grid.length, 2);
});

test("1 行でも形が違えば 1 行も書かない・Google に触らない", async () => {
  const f = fakeSheet([head]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good(), good({ 種類: "メモ" })] });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 0);
});

test("rows の中に同じ住所が 2 回あれば止める", async () => {
  const f = fakeSheet([head]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good(), good({ 名前: "別" })] });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /2 回/);
});

test("dry_run は書かない", async () => {
  const f = fakeSheet([head]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good()], dry_run: true });
  assert.equal(r.written, false);
  assert.deepEqual((r.added as { row_no: number }[]).map((a) => a.row_no), [2]);
  assert.ok(!f.calls.some((c) => c.includes("batchUpdate")));
});

test("見出しがそろわなければ書かない", async () => {
  const f = fakeSheet([["振り分けた日", "種類"]]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good()] });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /見出し/);
});

test("見出しの列の順がちがっても、見出しの文字で書く", async () => {
  const shuffled = [...head].reverse();
  const f = fakeSheet([shuffled]);
  const r = await putSozaiRows(f.sheets, "id", { rows: [good()] });
  assert.equal(r.ok, true);
  assert.equal(f.grid[1][shuffled.indexOf("種類")], "実績");
  assert.equal(f.grid[1][shuffled.indexOf("住所")], good().住所);
});

test("表の番号：設定があればそれ・無ければ名前で 1 つだけ", async () => {
  const one: SheetsJson = async <T>() => ({ files: [{ id: "S1", name: "素材の一覧" }] }) as T;
  const none: SheetsJson = async <T>() => ({ files: [] }) as T;
  const two: SheetsJson = async <T>() => ({ files: [{ id: "a" }, { id: "b" }] }) as T;
  assert.deepEqual(await resolveSheetId(one, ""), { id: "S1" });
  assert.deepEqual(await resolveSheetId(none, " X9 "), { id: "X9" });
  assert.ok("error" in (await resolveSheetId(none, undefined)));
  assert.ok("error" in (await resolveSheetId(two, undefined)));
});
