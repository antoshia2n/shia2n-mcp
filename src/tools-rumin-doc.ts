import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { getGoogleTokenForScope } from "./google-token.js";
import type { Env } from "./index.js";

/**
 * るーみんの YouTube 台本（Google ドキュメント）を、同じリンクのまま直す道具。
 * 命名規約：rumin_doc__<action>
 *
 * 2026-10-06 新設（v0.99.0・Naoki 依頼・るーみん案件）：rumin_doc__replace_text
 *   ・それまでは Claude がドキュメントの中身を書き換えられず、直すたびに「新しく作る → 古い方を 09 へ移す」をしていた。
 *     そのたびにリンクが変わり、Naoki と先生が古い版を開く事故が起きていた。その手をなくす口
 *   ・置き換えの組（探す文字 → 新しい文字）を 1〜20 組受け取り、その文字だけを置き換える
 *   ・探す文字がドキュメントの中にちょうど 1 か所あるときだけ置き換える。1 組でも 0 か所・2 か所以上なら 1 組も書かない
 *   ・書いてよいのは、台本フォルダ（SCRIPT_FOLDER_ID）の直下にあり、持ち主がフォルダの持ち主と同じドキュメントだけ。
 *     先生が持ち主のドキュメント（先生の正本「YouTube 台本」はフォルダにはショートカットだけがある）は、
 *     親がフォルダでない・持ち主が違う、の 2 つで止まる。メールアドレスはコードに書かない（置き場が公開のため）
 *   ・フォルダの番号はコードに書いた。フォルダは「リンクを知っている全員」に開いておらず（2026-10-06 に権限を見た）、
 *     番号だけでは中を見られないため。設定の値を増やさない（Naoki の手を増やさない）
 *   ・書くときは読んだ版（revisionId）を条件に付ける。読んでから書くまでに人が直していたら、Google が断る
 *   ・題名を変えられる（new_title）。題名を変えてもリンクは変わらない
 *   ・Google へは FIREBASE_SA_EMAIL の機械用の身分で入る。台本フォルダをそのメールアドレスへ編集者で共有する前提
 *   ・Google 側で Docs API と Drive API が有効である前提（無効なら reason で知らせる）
 */

const SCOPE = "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive";
const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const DOC_MIME = "application/vnd.google-apps.document";

/** 台本フォルダ（「岩永留美_シアニン_共有」/ 04_YouTube / 台本。マイドライブの共有フォルダで、共有ドライブではない） */
export const SCRIPT_FOLDER_ID = "1byh018XMJvFo1lk6QouxNDJ3oNCSPTep";
export const MAX_PAIRS = 20;
const MAX_FIND = 2000;
const MAX_REPLACE = 20000;
const MAX_TITLE = 300;
const CONTEXT = 30;

export type GoogleJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export interface Pair {
  find: string;
  replace: string;
}

export interface ReplaceInput {
  doc_id: string;
  replacements?: Pair[];
  new_title?: string;
  dry_run?: boolean;
}

/** 住所を渡されても番号を取り出す */
export function docIdFrom(value: string): string {
  const v = (value ?? "").trim();
  const m = /\/document\/d\/([A-Za-z0-9_-]+)/.exec(v);
  return m ? m[1] : v;
}

// ── ドキュメントの本文を 1 本の文字にし、1 文字ずつ Google の位置を持つ

type TextRun = { content?: string };
type ParaElement = { startIndex?: number; endIndex?: number; textRun?: TextRun };
type StructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: ParaElement[] };
  table?: { tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[] };
  tableOfContents?: { content?: StructuralElement[] };
};
export type DocJson = {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: StructuralElement[] };
};

export interface Flat {
  text: string;
  /** text の i 文字目が、ドキュメントの何番目か（Google の位置） */
  pos: number[];
  /** 本文の最後の位置（ここは消せない） */
  bodyEnd: number;
}

export function flatten(doc: DocJson): Flat {
  let text = "";
  const pos: number[] = [];
  let bodyEnd = 0;
  const walk = (items: StructuralElement[] | undefined) => {
    for (const el of items ?? []) {
      if (typeof el.endIndex === "number") bodyEnd = Math.max(bodyEnd, el.endIndex);
      for (const pe of el.paragraph?.elements ?? []) {
        const content = pe.textRun?.content;
        if (typeof content !== "string" || typeof pe.startIndex !== "number") continue;
        // Google の位置は UTF-16 の 1 単位ずつ。JS の文字列も同じ単位なので 1 対 1 で並べられる
        for (let i = 0; i < content.length; i++) pos.push(pe.startIndex + i);
        text += content;
      }
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content);
      walk(el.tableOfContents?.content);
    }
  };
  walk(doc.body?.content);
  return { text, pos, bodyEnd };
}

/** 重なりも含めて、すべての出現の位置 */
export function findAll(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return out;
    out.push(at);
    from = at + 1;
  }
}

function around(text: string, start: number, length: number) {
  return {
    before: text.slice(Math.max(0, start - CONTEXT), start),
    match: text.slice(start, start + length),
    after: text.slice(start + length, start + length + CONTEXT),
  };
}

type Located = { i: number; find: string; replace: string; start: number; docStart: number; docEnd: number };

/**
 * 口の中身。Google への呼び出しは google に寄せてあるので、偽物を渡せば手元で通しで確かめられる。
 */
export async function replaceInRuminDoc(google: GoogleJson, input: ReplaceInput): Promise<Record<string, unknown>> {
  const docId = docIdFrom(input.doc_id);
  const pairs = (input.replacements ?? []).map((p) => ({ find: p.find ?? "", replace: p.replace ?? "" }));
  const newTitle = input.new_title === undefined ? undefined : input.new_title.trim();
  const dryRun = input.dry_run === true;
  const url = `https://docs.google.com/document/d/${docId}/edit`;
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    written: false,
    reason,
    doc_id: docId,
    ...extra,
  });

  // ── 受け付ける形か（ここで止まったら Google には 1 回も触らない）
  if (!/^[A-Za-z0-9_-]{20,}$/.test(docId)) return refuse("doc_id はドキュメントの番号か住所を渡してください。書きませんでした");
  if (pairs.length === 0 && newTitle === undefined) {
    return refuse("replacements（1〜20 組）か new_title のどちらかは渡してください。書きませんでした");
  }
  if (pairs.length > MAX_PAIRS) return refuse(`replacements は ${MAX_PAIRS} 組までです（${pairs.length} 組）。書きませんでした`);
  const badPair = pairs.findIndex((p) => p.find === "" || p.find.length > MAX_FIND || p.replace.length > MAX_REPLACE);
  if (badPair >= 0) {
    return refuse(
      `${badPair + 1} 組目の形が合いません（find は 1〜${MAX_FIND} 文字、replace は ${MAX_REPLACE} 文字まで）。書きませんでした`
    );
  }
  if (newTitle !== undefined && (newTitle === "" || newTitle.length > MAX_TITLE || /[\r\n]/.test(newTitle))) {
    return refuse(`new_title は 1〜${MAX_TITLE} 文字・改行なしで渡してください。書きませんでした`);
  }

  // ── 書いてよいドキュメントか：種類・ごみ箱・親が台本フォルダ・持ち主がフォルダの持ち主と同じ
  type FileMeta = { id?: string; name?: string; mimeType?: string; trashed?: boolean; parents?: string[]; owners?: { emailAddress?: string }[] };
  const fields = encodeURIComponent("id,name,mimeType,trashed,parents,owners(emailAddress)");
  const file = await google<FileMeta>(`${DRIVE}/${docId}?fields=${fields}&supportsAllDrives=true`);
  if (file.mimeType !== DOC_MIME) {
    return refuse(`Google ドキュメントではありません（${file.mimeType ?? "種類不明"}）。ショートカットなら元のドキュメントは台本フォルダの外にあります。書きませんでした`, { title: file.name });
  }
  if (file.trashed) return refuse("ごみ箱にあるドキュメントです。書きませんでした", { title: file.name });
  if (!(file.parents ?? []).includes(SCRIPT_FOLDER_ID)) {
    return refuse("台本フォルダの直下にないドキュメントです。書いてよいのは台本フォルダの直下だけです。書きませんでした", { title: file.name });
  }
  const folder = await google<FileMeta>(`${DRIVE}/${SCRIPT_FOLDER_ID}?fields=${encodeURIComponent("owners(emailAddress)")}&supportsAllDrives=true`);
  const folderOwners = new Set((folder.owners ?? []).map((o) => (o.emailAddress ?? "").toLowerCase()).filter(Boolean));
  const fileOwners = (file.owners ?? []).map((o) => (o.emailAddress ?? "").toLowerCase()).filter(Boolean);
  // 共有ドライブなら持ち主の欄は空。そのときは親がフォルダであることだけで判定する
  if (fileOwners.some((o) => !folderOwners.has(o))) {
    return refuse("持ち主が台本フォルダの持ち主と違うドキュメントです（先生が持ち主のドキュメントには書きません）。書きませんでした", { title: file.name });
  }

  // ── 本文を読み、各組がちょうど 1 か所かを数える
  const doc = await google<DocJson>(`${DOCS}/${docId}`);
  const flat = flatten(doc);
  const counts = pairs.map((p, i) => ({ i: i + 1, find: p.find, count: findAll(flat.text, p.find).length }));
  const notOne = counts.filter((c) => c.count !== 1);
  if (notOne.length > 0) {
    return refuse("ちょうど 1 か所でない組があります。1 組も書きませんでした", {
      title: doc.title,
      counts: counts.map((c) => ({ i: c.i, find: c.find.slice(0, 60), count: c.count })),
    });
  }
  const located: Located[] = pairs.map((p, i) => {
    const start = findAll(flat.text, p.find)[0];
    return { i: i + 1, find: p.find, replace: p.replace, start, docStart: flat.pos[start], docEnd: flat.pos[start + p.find.length - 1] + 1 };
  });
  // 見つかった文字の間に、文字でないもの（画像など）が挟まっていないか
  const gapped = located.filter((l) => l.docEnd - l.docStart !== l.find.length);
  if (gapped.length > 0) {
    return refuse("探す文字の間に画像などの文字でないものが挟まっています。1 組も書きませんでした", {
      title: doc.title,
      pairs: gapped.map((l) => l.i),
    });
  }
  if (located.some((l) => l.docEnd >= flat.bodyEnd)) {
    return refuse("本文の最後の改行は消せません。探す文字から最後の改行を外してください。1 組も書きませんでした", { title: doc.title });
  }
  const sorted = [...located].sort((a, b) => a.start - b.start);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].start < sorted[k - 1].start + sorted[k - 1].find.length) {
      return refuse(`${sorted[k - 1].i} 組目と ${sorted[k].i} 組目の探す文字が重なっています。1 組も書きませんでした`, { title: doc.title });
    }
  }

  const preview = located.map((l) => ({ i: l.i, ...around(flat.text, l.start, l.find.length), replace: l.replace }));
  const base = { doc_id: docId, url, title_before: doc.title, title_after: newTitle ?? doc.title };
  if (dryRun) return { ok: true, written: false, dry_run: true, ...base, pairs: preview };

  // ── 書く。後ろの組から消して入れる（前の位置がずれないため）。読んだ版を条件に付ける
  if (located.length > 0) {
    const requests: unknown[] = [];
    for (const l of [...sorted].reverse()) {
      requests.push({ deleteContentRange: { range: { startIndex: l.docStart, endIndex: l.docEnd } } });
      if (l.replace !== "") requests.push({ insertText: { location: { index: l.docStart }, text: l.replace } });
    }
    await google(`${DOCS}/${docId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests, writeControl: { requiredRevisionId: doc.revisionId } }),
    });
  }
  if (newTitle !== undefined && newTitle !== doc.title) {
    try {
      await google(`${DRIVE}/${docId}?supportsAllDrives=true&fields=${encodeURIComponent("id,name")}`, {
        method: "PATCH",
        body: JSON.stringify({ name: newTitle }),
      });
    } catch (e: unknown) {
      return {
        ok: false,
        written: located.length > 0,
        reason: located.length > 0 ? "本文は置き換えましたが、題名を変えられませんでした" : "題名を変えられませんでした",
        ...base,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 600),
      };
    }
  }

  // ── 読み直す。置き換えた所に新しい文字が入っているか（前の組で位置がずれる分を足して探す）
  const again = await google<DocJson>(`${DOCS}/${docId}`);
  const flat2 = flatten(again);
  let shift = 0;
  const results = sorted.map((l) => {
    const at = l.start + shift;
    shift += l.replace.length - l.find.length;
    const got = flat2.text.slice(at, at + l.replace.length);
    return { i: l.i, ok: got === l.replace, ...around(flat2.text, at, l.replace.length) };
  });
  results.sort((a, b) => a.i - b.i);
  const titleNow = again.title;
  const mismatched = results.filter((r) => !r.ok).map((r) => r.i);
  const titleOk = newTitle === undefined || titleNow === newTitle;
  if (mismatched.length > 0 || !titleOk || again.documentId !== docId) {
    return {
      ok: false,
      written: true,
      reason: "書いたあとに読み直すと、合わない所があります。人が同時に直した可能性があります",
      ...base,
      title_now: titleNow,
      mismatched,
      pairs: results,
    };
  }
  return { ok: true, written: true, dry_run: false, ...base, title_now: titleNow, pairs: results };
}

export function registerRuminDocTools(server: McpServer, env: Env): void {
  server.tool(
    "rumin_doc__replace_text",
    "るーみんの YouTube 台本（Google ドキュメント）を、同じリンクのまま直す。置き換えの組（find → replace）を 1〜20 組受け取り、その文字だけを置き換える。find がドキュメントの本文にちょうど 1 か所あるときだけ置き換え、1 組でも 0 か所・2 か所以上なら 1 組も書かずに、各組が何か所だったか（counts）を返す。replace は改行を含めてよい（段落をまるごと差し替えられる）。空の replace は消すだけ。new_title を渡すと題名も変える（リンクは変わらない）。dry_run=true なら書かずに、各組の前後 30 字ほどを返す。書いたあとは読み直して、置き換えた所の前後の文を返す。書けるのは台本フォルダ（04_YouTube / 台本）の直下のドキュメントだけで、先生が持ち主のドキュメント・フォルダの外のドキュメント・ショートカットには書かない。",
    {
      doc_id: z.string().describe("ドキュメントの番号、または docs.google.com/document/d/… の住所"),
      replacements: z
        .array(
          z.object({
            find: z.string().describe("探す文字（本文にちょうど 1 か所あること）"),
            replace: z.string().describe("新しい文字（改行を含めてよい・空なら消すだけ）"),
          })
        )
        .max(MAX_PAIRS)
        .optional()
        .describe("置き換えの組。1〜20 組（new_title だけ変えるときは省いてよい）"),
      new_title: z.string().optional().describe("新しい題名（版の番号を上げるときなど）"),
      dry_run: z.boolean().optional().describe("true なら書かずに、各組の前後の文だけを返す"),
    },
    async (args) => {
      try {
        const token = await getGoogleTokenForScope(env, SCOPE);
        const google: GoogleJson = async <T>(u: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${token}`);
          if (init.body) headers.set("content-type", "application/json");
          const res = await fetch(u, { ...init, headers });
          if (!res.ok) throw new Error(`Google ${res.status}: ${await res.text()}`);
          return (await res.json()) as T;
        };
        return asMcpTextResult(await replaceInRuminDoc(google, args));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        const disabled = /SERVICE_DISABLED|has not been used in project|is disabled/.test(message);
        const noAccess = !disabled && /Google (403|404)/.test(message);
        const revision = /requiredRevisionId|revision/i.test(message) && /Google 400/.test(message);
        return asMcpTextResult({
          ok: false,
          written: false,
          reason: disabled
            ? "Google 側で Docs API か Drive API が有効になっていません。error の中の住所を開いて有効にしてください"
            : noAccess
              ? "ドキュメントを開けません。台本フォルダを share_with のメールアドレスへ編集者で共有してください"
              : revision
                ? "読んでから書くまでの間に、誰かがドキュメントを直しました。何も書いていません。もう一度呼んでください"
                : "Google への呼び出しで止まりました",
          share_with: noAccess ? env.FIREBASE_SA_EMAIL : undefined,
          error: message.slice(0, 600),
        });
      }
    }
  );
}
