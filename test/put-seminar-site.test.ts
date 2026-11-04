// mn__put_seminar の書き先が会員サイトの表になったこと（src/tools-manabu-seminar.ts）。esbuild で束ねてから node --test。
import test from "node:test";
import assert from "node:assert/strict";
import { putSeminar } from "../src/tools-manabu-seminar.js";

type Row = Record<string, any>;
function fakeDb() {
  const db: Record<string, Row[]> = {
    b_site_programs: [{ id: "p1", title: "しあらぼセミナーアーカイブ" }],
    b_site_courses: [{ id: "c26", program_id: "p1", title: "2026年", sort: 2026 }],
    b_site_contents: [{ id: "old", title: "超リサーチ思考", video_url: "https://www.youtube.com/watch?v=eaCZw7VtMhM" }],
    b_site_content_courses: [{ content_id: "old", course_id: "c26", sort: 20261028 }],
  };
  const calls: string[] = [];
  const match = (r: Row, q: URLSearchParams) =>
    [...q.entries()].every(([k, v]) => {
      if (k === "select") return true;
      if (v.startsWith("eq.")) return String(r[k]) === v.slice(3);
      if (v.startsWith("in.(")) return v.slice(4, -1).split(",").map((x) => x.replace(/"/g, "")).includes(String(r[k]));
      return true;
    });
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop()!;
    const method = init.method || "GET";
    calls.push(`${method} ${table}`);
    if (table.startsWith("mn_")) throw new Error("学ぶくんへ書きに行った");
    const rows = db[table];
    if (method === "GET") return new Response(JSON.stringify(rows.filter((r) => match(r, u.searchParams))));
    if (method === "POST") { const b = JSON.parse(init.body); rows.push(b); return new Response(JSON.stringify([b])); }
    if (method === "PATCH") { const b = JSON.parse(init.body); const hit = rows.filter((r) => match(r, u.searchParams)); hit.forEach((r) => Object.assign(r, b)); return new Response(JSON.stringify(hit)); }
    throw new Error(method);
  };
  return { db, calls };
}
const env: any = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };

test("新しい回は会員サイトの年の棚に、日付の並び順と種類セミナーで入る", async () => {
  const { db, calls } = fakeDb();
  const r: any = await putSeminar(env, { year: "2026", rows: [
    { date: "2026-11-03", title: "noteメンシプLPページ設計", video_url: "https://www.youtube.com/watch?v=4wL5zU6OqSU", mindmap_url: "https://mindmap.shia2n.jp/s/a" },
  ] });
  assert.equal(r.足した本数, 1);
  assert.equal(r.この棚の今の件数, 2);
  const c = db.b_site_contents.find((x) => x.title === "noteメンシプLPページ設計")!;
  assert.equal(c.kind, "セミナー");
  assert.equal(c.video_url, "https://www.youtube.com/watch?v=4wL5zU6OqSU");
  assert.match(c.body, /^開催日：2026-11-03\n\n\{\{youtube:4wL5zU6OqSU\}\}/);
  assert.equal(c.summary, "2026-11-03 ｜ ");
  assert.deepEqual(db.b_site_content_courses.find((x) => x.content_id === c.id), { content_id: c.id, course_id: "c26", sort: 20261103 });
  assert.ok(!calls.some((x) => x.includes("mn_")));
});

test("同じ日付の回があれば足さずに書き換える（二重にならない）", async () => {
  const { db } = fakeDb();
  const r: any = await putSeminar(env, { year: "2026", rows: [{ date: "2026-10-28", title: "超リサーチ思考（改）", video_url: "https://youtu.be/eaCZw7VtMhM" }] });
  assert.equal(r.書き換えた本数, 1);
  assert.equal(r.足した本数, 0);
  assert.equal(db.b_site_contents.length, 1);
  assert.equal(db.b_site_contents[0].title, "超リサーチ思考（改）");
});

test("年の棚が無ければ作り、並び順は年の数", async () => {
  const { db } = fakeDb();
  const r: any = await putSeminar(env, { year: "2027", rows: [{ date: "2027-01-05", title: "初回" }] });
  assert.equal(r.コース.新しく作った, true);
  assert.equal(db.b_site_courses.find((x) => x.title === "2027年")!.sort, 2027);
});

test("プログラムが無ければ書かずに止まる", async () => {
  const { db } = fakeDb();
  db.b_site_programs.length = 0;
  await assert.rejects(putSeminar(env, { year: "2026", rows: [{ date: "2026-11-03", title: "x" }] }), /プログラムが 0 件/);
  assert.equal(db.b_site_contents.length, 1);
});
