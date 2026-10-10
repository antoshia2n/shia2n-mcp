/**
 * db__impact（土台 6 番・2026-10-10 開発部）：表を 1 本変えたときに、何が壊れるかを人に聞かずに引く。
 * タスク：https://www.notion.so/3d59c6c1c439813ba590decd13c37660
 *
 * 返すのは 3 段と、この道具自体の健康
 *   ① データベースの中：データベース側の読み出し専用の処理 list_table_dependents（sql/list_table_dependents.sql）を呼ぶ。
 *      ビュー・処理・引き金・守りの決まり・外部キー・ブラウザ側の許可・定時の処理
 *   ② コードの中：読む先は Systems の稼働中と開発中の行のリポジトリ（毎回読む。一覧をここに持たない）。
 *      公開のものは codeload から固まりを 1 回で取る。読めなかったものは、鍵（GITHUB_READ_TOKEN、無ければ GITHUB_TOKEN）があれば API でもう 1 回試す
 *   ③ 見ていない先：読めなかったリポジトリを名前と理由で並べる。0 件と混ぜない
 *   健康：最後に引けた日時・表・読めた本数と見ていない本数（OAUTH_KV の 1 行）
 * 読むだけで、書く表は 0。新しい表も作らない。外への呼び出しは MAX_OUTBOUND 本で頭打ちにし、超えた分は「今回は調べていない」で返す。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./index.js";
import { TABLE_RE, untarSources, gunzip, findInRepo, targetsFromSystems, type RepoTarget, readInOrder } from "./impact-core.js";

const SYSTEMS_DATA_SOURCE_ID = "f4132219-976e-48ba-ad3a-452108a6ee30";
const NOTION_VERSION = "2025-09-03";
/**
 * 頭打ち。一覧 1〜2・データベース 1・リポジトリ 1 本につき 1〜3（公開 1・非公開 3）。28 本ならいちばん多くて 87。
 * v1.6.4：45 から 120 に上げた。このアカウントは有料の枠（1 回 10,000 本）で、同じアカウントの zeus-worker が
 * 1 回 300 本台を通している（zeus-worker の src/index.js の注）。45 では非公開 18 本のうち 11 本を読めなかった（2026-10-10 実測）
 */
const MAX_OUTBOUND = 120;
const HEALTH_KEY = "impact:last";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function readSystems(env: Env, budget: { left: number }): Promise<{ pages: any[]; error?: string }> {
  const pages: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 2 && budget.left > 0; i++) {
    budget.left--;
    let res: Response;
    try {
      res = await fetch(`https://api.notion.com/v1/data_sources/${SYSTEMS_DATA_SOURCE_ID}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
    } catch (e) {
      return { pages, error: `Systems に届かなかった（${String(e)}）` };
    }
    if (!res.ok) return { pages, error: `Systems の読み込みに失敗（${res.status}）` };
    const j = (await res.json()) as { results?: any[]; has_more?: boolean; next_cursor?: string | null };
    pages.push(...(j.results ?? []));
    if (!(j.has_more && j.next_cursor)) return { pages };
    cursor = j.next_cursor;
  }
  return { pages };
}

async function readDatabase(env: Env, table: string, budget: { left: number }): Promise<any> {
  budget.left--;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/list_table_dependents`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_table: table }),
    });
    const body = await res.text();
    if (res.status === 404) {
      return { ok: false, error: "not_installed", note: "データベース側の処理 list_table_dependents がまだ置かれていない（sql/list_table_dependents.sql）。0 件ではなく未設置" };
    }
    if (!res.ok) return { ok: false, error: "lookup_failed", status: res.status, detail: body.slice(0, 300) };
    return JSON.parse(body);
  } catch (e) {
    return { ok: false, error: "lookup_failed", detail: String(e) };
  }
}

// 読むだけの鍵を先に使う（書く鍵の範囲を広げないため・v1.6.3）
function readKey(env: Env): string | undefined {
  return env.GITHUB_READ_TOKEN || env.GITHUB_TOKEN;
}

type RepoRead = { ok: true; via: string; files: ReturnType<typeof untarSources> } | { ok: false; reason: string; status?: number };

// 1 回目：公開の固まりを codeload から取る（1 本と数える）
async function readPublic(t: RepoTarget, budget: { left: number }): Promise<RepoRead> {
  if (budget.left < 1) return { ok: false, reason: "今回は調べていない（外への呼び出しの上限）" };
  budget.left--;
  try {
    const r = await fetch(`https://codeload.github.com/${t.repo}/tar.gz/HEAD`, { signal: AbortSignal.timeout(20000) });
    if (r.ok) return { ok: true, via: "codeload", files: untarSources(await gunzip(await r.arrayBuffer())) };
    return { ok: false, reason: `非公開か消えている（${r.status}）`, status: r.status };
  } catch (e) {
    return { ok: false, reason: `読めなかった（${String(e).slice(0, 120)}）` };
  }
}

// 2 回目：codeload で読めなかったものだけ、鍵で API から取る（別の住所へ移されるので 2 本と数える）
async function readWithKey(env: Env, t: RepoTarget, first: number, budget: { left: number }): Promise<RepoRead> {
  if (budget.left < 2) return { ok: false, reason: `非公開か消えている（${first}）・鍵で試す前に上限` };
  budget.left -= 2;
  try {
    const r = await fetch(`https://api.github.com/repos/${t.repo}/tarball`, {
      headers: { Authorization: `Bearer ${readKey(env)}`, Accept: "application/vnd.github+json", "User-Agent": "shia2n-mcp" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return { ok: true, via: "api", files: untarSources(await gunzip(await r.arrayBuffer())) };
    return { ok: false, reason: `非公開で鍵でも読めない（${first}→${r.status}）`, status: r.status };
  } catch (e) {
    return { ok: false, reason: `鍵で読めなかった（${String(e).slice(0, 120)}）` };
  }
}

async function readAllRepos(env: Env, targets: RepoTarget[], budget: { left: number }): Promise<RepoRead[]> {
  return readInOrder<RepoTarget, RepoRead>(
    targets,
    (t) => readPublic(t, budget),
    (t, first) => readWithKey(env, t, first, budget),
    !!readKey(env),
  );
}

export function registerImpactTools(server: McpServer, env: Env) {
  server.tool(
    "db__impact",
    "表を 1 本変えたときに何が壊れるかを引く（土台 6 番）。表の名前を 1 つ渡すと、① データベースの中（その表を使うビュー・処理・引き金・守りの決まり・外部キー・ブラウザ側の許可・定時の処理）② コードの中（Systems の稼働中と開発中のリポジトリで、その表の名前が出るファイルと行）③ 見ていない先（読めなかったリポジトリと理由）を、本数つきで返す。健康の口として、前に引けた日時と本数も返す。読むだけで、書く表は 0。0 件と失敗は別の戻り値。",
    {
      table: z.string().describe("public の表の名前（例 member・shr_members・b_events）"),
    },
    async ({ table }) => {
      const name = String(table || "").trim();
      let previous: unknown = null;
      try { previous = JSON.parse((await env.OAUTH_KV.get(HEALTH_KEY)) || "null"); } catch { previous = "読めなかった"; }
      if (!TABLE_RE.test(name)) {
        return textResult({ ok: false, error: "bad_table_name", note: "英小文字・数字・_ で、英小文字か _ で始まる名前だけ", health: { previous } });
      }

      const budget = { left: MAX_OUTBOUND };
      const systems = await readSystems(env, budget);
      if (systems.error) {
        return textResult({ ok: false, error: "systems_unreadable", detail: systems.error, note: "読む先の一覧が取れないので、コードの中は 1 本も見ていない（0 件ではない）", health: { previous } });
      }
      const targets = targetsFromSystems(systems.pages);
      const database = await readDatabase(env, name, budget);

      const code: unknown[] = [];
      const readNoHits: string[] = [];
      const unseen: { app: string; repo: string; use: string | null; reason: string }[] = [];
      let files = 0;
      let lines = 0;
      const got = await readAllRepos(env, targets, budget);
      targets.forEach((t, k) => {
        const g = got[k];
        if (!g.ok) { unseen.push({ app: t.app, repo: t.repo, use: t.use, reason: g.reason }); return; }
        const f = findInRepo(g.files, name);
        if (!f.total_files) { readNoHits.push(t.repo); return; }
        files += f.total_files;
        lines += f.total_lines;
        code.push({ app: t.app, repo: t.repo, use: t.use, read_via: g.via, files_scanned: g.files.length, files_with_hits: f.total_files, lines: f.total_lines, aliases: f.aliases, files: f.files });
      });

      const db = database && database.ok ? database : null;
      const dbCount = db && db.exists
        ? ["views", "functions", "triggers", "policies", "foreign_keys_in", "foreign_keys_out"].reduce((n, k) => n + (Array.isArray(db[k]) ? db[k].length : 0), 0) + (Array.isArray(db.cron_jobs) ? db.cron_jobs.length : 0)
        : null;
      const summary = {
        db_dependents: dbCount, // null＝引けなかったか表が無い
        repos_using: code.length,
        files_using: files,
        lines_using: lines,
        repos_read: code.length + readNoHits.length,
        repos_unseen: unseen.length,
        repos_listed: targets.length,
        outbound_used: MAX_OUTBOUND - budget.left,
      };
      const now = new Date().toISOString();
      const health = { at: now, table: name, repos_read: summary.repos_read, repos_unseen: summary.repos_unseen, database_ok: !!db };
      try { await env.OAUTH_KV.put(HEALTH_KEY, JSON.stringify(health)); } catch { /* 健康の記録が書けなくても、引いた結果は返す */ }

      return textResult({
        ok: true,
        table: name,
        summary,
        database,
        code,
        read_without_hits: readNoHits,
        unseen,
        health: { now: health, previous },
        note: "コードの中は「引用符か URL の中の名前・public.名前・.sql のファイルの名前・読み替えの表の左の名前」を拾う。名前を組み立てて呼ぶ所と、変数に入れた名前を別のファイルで使う所は拾えない。unseen のリポジトリは見ていないので、そこに使う先が無いとは言えない",
      });
    },
  );
}
