/**
 * 土台 6 番：表を 1 本変えたときに壊れるものを引く（コードの中を探す側の、外に出ない部分）。2026-10-10 開発部
 *
 * ここに置くのは「固まり（tar.gz）をほどく」「表の名前が出る行を拾う」「Systems の行から読む先を決める」の 3 つだけ。
 * 外への呼び出しは tools-impact.ts が持つ。手元の試験（test/impact.test.ts）はこのファイルだけを読む。
 *
 * 表の名前を拾う決まり（各アプリの書き方を 2026-10-10 に公開の 10 本で見て決めた）
 *   ① 引用符の中か URL の中の名前：直前が ' " ` / のどれかで、直後が ' " ` ? / のどれか
 *      例 .from('member')・"member"・`${url}/rest/v1/member?select=`・"events?select=..."
 *   ② SQL の書き方 public.名前
 *   ③ .sql のファイルは、前後が英数字と _ でない名前を全部
 *   ④ 読み替えの表（B の index.js の `events: "b_events"` の形）があれば、左の名前（events）も同じリポジトリで ① の決まりで拾う
 * 拾えないもの：名前を組み立てて呼ぶ所（"b_" + x など）・変数に入れた名前を別のファイルで使う所。返事の note に書く。
 */

export const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

const SOURCE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|sql|vue|svelte|html)$/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.wrangler|coverage|vendor)\/|\.min\.|package-lock\.json$/;
const MAX_FILE_BYTES = 400_000;
export const MAX_LINES_PER_FILE = 8;
export const MAX_FILES_PER_REPO = 40;

export interface TarFile {
  path: string;
  text: string;
}

const dec = new TextDecoder();

function cstr(b: Uint8Array, from: number, len: number): string {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(from, end));
}

/** tar をほどいて、ソースのファイルだけを返す。最初の 1 段（リポジトリ名-版）は外す */
export function untarSources(buf: Uint8Array): TarFile[] {
  const out: TarFile[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = cstr(h, 0, 100);
    const size = parseInt(cstr(h, 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x") {
      // pax の見出し：path= があれば次の 1 件の名前
      const m = dec.decode(data).match(/\d+ path=([^\n]+)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue; // 全体の見出し（GitHub の版の番号など）
    if (type === "L") { longName = cstr(data, 0, data.length); continue; }

    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type !== "0" && type !== "\0") continue; // ふつうのファイルだけ
    const path = full.split("/").slice(1).join("/");
    if (!path || !SOURCE_EXT.test(path) || SKIP_PATH.test(path) || size > MAX_FILE_BYTES) continue;
    out.push({ path, text: dec.decode(data) });
  }
  return out;
}

export async function gunzip(body: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Hit {
  n: number;
  text: string;
  via: string; // name・public・sql・alias:キー
}
export interface FileHits {
  path: string;
  lines: Hit[];
  more: number; // 載せきれなかった行の数
}

/** 1 本のリポジトリの中で、表の名前が出る行を拾う */
export function findInRepo(files: TarFile[], table: string): { files: FileHits[]; total_lines: number; total_files: number; aliases: string[] } {
  const t = esc(table);
  const quoted = (name: string) => new RegExp(`["'\`/]${esc(name)}(?=["'\`?/])`);
  const reName = quoted(table);
  const rePublic = new RegExp(`(?<![A-Za-z0-9_])public\\.${t}(?![A-Za-z0-9_])`);
  const reWord = new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`);
  const reAliasDef = new RegExp(`(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*["']${t}["']`, "g");

  // ④ 読み替えの左の名前を先に集める。左の名前は表の名前の末尾と一致するものだけ（events: "b_events" の形）。
  //    v1.6.2：table: "member" のような設定の鍵を読み替えと見て、'table' の行まで拾っていたため（2026-10-10 実測で 2 行）
  const aliases = new Set<string>();
  for (const f of files) {
    for (const m of f.text.matchAll(reAliasDef)) if (m[1] !== table && table.endsWith(`_${m[1]}`)) aliases.add(m[1]);
  }
  const aliasRes = [...aliases].map((a) => ({ a, re: quoted(a) }));

  const result: FileHits[] = [];
  let totalLines = 0;
  for (const f of files) {
    const isSql = /\.sql$/i.test(f.path);
    const lines = f.text.split("\n");
    const hits: Hit[] = [];
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let via: string | null = null;
      if (isSql ? reWord.test(line) : reName.test(line)) via = isSql ? "sql" : "name";
      else if (rePublic.test(line)) via = "public";
      else {
        for (const { a, re } of aliasRes) if (re.test(line)) { via = `alias:${a}`; break; }
      }
      if (!via) continue;
      count++;
      if (hits.length < MAX_LINES_PER_FILE) hits.push({ n: i + 1, text: line.trim().slice(0, 160), via });
    }
    if (count) {
      totalLines += count;
      result.push({ path: f.path, lines: hits, more: count - hits.length });
    }
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return { files: result.slice(0, MAX_FILES_PER_REPO), total_lines: totalLines, total_files: result.length, aliases: [...aliases] };
}

export interface RepoTarget {
  app: string;
  use: string | null;
  repo: string; // owner/name
}

/** Systems の行（Notion の生の形）から、読む先のリポジトリを決める。稼働中と開発中だけ・同じリポジトリは 1 回 */
export function targetsFromSystems(pages: any[]): RepoTarget[] {
  const seen = new Set<string>();
  const out: RepoTarget[] = [];
  for (const page of pages) {
    const p = page?.properties ?? {};
    const use = p["使用"]?.select?.name ?? null;
    if (use !== "稼働中" && use !== "開発中") continue;
    const url = p["リポジトリURL"]?.url;
    const m = typeof url === "string" ? url.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/) : null;
    if (!m) continue;
    const repo = m[1];
    if (seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    const title = p["システム名"]?.title;
    const app = Array.isArray(title) ? title.map((x: any) => x?.plain_text ?? "").join("").trim() : "";
    out.push({ app: app || repo, use, repo });
  }
  return out;
}

/**
 * v1.6.1：リポジトリを読む順番。公開（codeload）を全部先に読み、読めなかった分にだけ鍵を使う。
 * 鍵で 404 が 2 本続き、1 本も読めていなければ、鍵に非公開を読む許可が無いと見て残りは試さない。
 * 1.6.0 は 1 本ずつ「codeload → 鍵」を続けたので、非公開の 404 で上限 45 を使い切り、
 * 後ろに並んだ公開のリポジトリ（shia2n-mcp など）を読まずに返していた（2026-10-10 実測）。
 */
export type ReadResult = { ok: boolean; status?: number; reason?: string };
export async function readInOrder<T, R extends ReadResult>(
  targets: T[],
  readPublic: (t: T) => Promise<R>,
  readWithKey: (t: T, first: number) => Promise<R>,
  hasKey: boolean,
): Promise<R[]> {
  const out: R[] = new Array(targets.length);
  for (let i = 0; i < targets.length; i += 4) {
    const idx = targets.slice(i, i + 4).map((_, k) => i + k);
    const got = await Promise.all(idx.map((j) => readPublic(targets[j])));
    idx.forEach((j, k) => { out[j] = got[k]; });
  }
  const retry = out.map((g, j) => (!g.ok && g.status ? j : -1)).filter((j) => j >= 0);
  if (!hasKey) {
    for (const j of retry) out[j] = { ok: false, reason: `非公開か消えている（${out[j].status}）・鍵が無い` } as R;
    return out;
  }
  let keyNoAccess = 0;
  let keyWorked = false;
  for (const j of retry) {
    const first = out[j].status as number;
    if (!keyWorked && keyNoAccess >= 2) {
      out[j] = { ok: false, reason: `非公開か消えている（${first}）・鍵に非公開を読む許可が無いと見て試していない` } as R;
      continue;
    }
    const g = await readWithKey(targets[j], first);
    out[j] = g;
    if (g.ok) keyWorked = true;
    else if (g.status === 404) keyNoAccess++;
  }
  return out;
}
