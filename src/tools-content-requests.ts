import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import { callContentOsInternalApi } from "./tools-content-os.js";
import { getGoogleTokenForScope } from "./google-token.js";
import { driveIdFromUrl, sniffImage, typeSaysNotImage } from "./image-sniff.js";
import type { Env } from "./index.js";

/**
 * v1.72.0（2026-11-10 開発部）：コンテンツくんの「依頼」（content_requests・作業69）を読む・書き戻す道具。
 * コンテンツくんでチェックを入れた依頼（引用の図解・記事内の図解・サムネ・本文）を、
 * ChatGPT の予定タスクが 1 時間ごとに読み、初稿を書き戻す。Naoki はそのチャットで仕上げ、OK で done にする。
 * 中身は content-os の /api/internal/list-requests と put-result。書けるのは結果と状態だけ（依頼の中身は変えられない）。
 */
export const CONTENT_REQUEST_TOOLS = ["content_os__list_requests", "content_os__put_result", "content_os__list_templates", "content_os__save_template"] as const;

export function registerContentRequestTools(server: McpServer, env: Env): void {
  server.tool(
    "content_os__list_requests",
    "コンテンツくんの依頼（チェックで作られた、初稿づくりの依頼）を読む。既定は未着手（queued）を古い順に最大10件。各依頼に、もとの投稿（題・本文の文字）と、使う依頼の型（template.content）が付いて返る。kind＝作るもの（quote_figure 引用の図解／article_figure 記事内の図解／thumbnail サムネ／text 本文）、media＝媒体（x_article／note／x_post）、instruction＝Naoki の指示。id を渡すとその1件だけ返す。戻り値: { ok, count, requests: [...] }。",
    {
      status: z
        .array(z.enum(["queued", "drafting", "review", "done", "cancelled"]))
        .optional()
        .describe("読む状態。省略時は ['queued']"),
      id: z.string().optional().describe("依頼の番号（uuid）。渡すとその1件だけ"),
      limit: z.number().int().min(1).max(30).optional().describe("最大件数（既定10）"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "list-requests", args))
  );

  server.tool(
    "content_os__put_result",
    "コンテンツくんの依頼に、作ったもの（初稿・仕上げ）を書き戻す。status は drafting（作り始めた）／review（初稿ができた・Naoki の確認待ち。既定）／done（Naoki が OK と言った）。result_text に文の成果、画像は content_os__put_images でファイルのまま渡す（型に「put_result の images へ」とあっても put_images を使う。大きい画像は base64 で運べない）。images に画像（base64・png/jpeg/webp・1枚8MBまで・最大6枚）を渡すと、コンテンツくんの置き場へ入れて住所を残す。urls には https の住所（Drive など）をそのまま足せる。replace_images=true で前の画像を外して入れ直す。done にしてよいのは Naoki が会話の中で OK と言ったときだけ。戻り値: { ok, request }。取り消し済みは 409。",
    {
      id: z.string().describe("依頼の番号（uuid。content_os__list_requests の id）"),
      status: z.enum(["drafting", "review", "done"]).optional().describe("既定 review"),
      result_text: z.string().max(50000).optional().describe("文の成果（本文・図解の文言・サムネの文字など）"),
      images: z
        .array(z.object({
          base64: z.string().describe("画像の base64（data: で始まってもよい）"),
          mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional(),
          label: z.string().max(100).optional(),
        }))
        .max(6)
        .optional(),
      urls: z.array(z.string().url()).max(10).optional().describe("https の住所（Drive の共有リンクなど）"),
      replace_images: z.boolean().optional(),
      note: z.string().max(2000).optional().describe("Naoki への申し送り（1〜2行）"),
    },
    async (args) => {
      const out = await callContentOsInternalApi<Record<string, unknown>>(env, "put-result", args);
      // v1.80.0：画像を入れた回だけ、ドライブの「コンテンツくん/月/日付_題/種類/」へも写す。失敗しても書き戻しは止めない
      if (args.images?.length && out && (out as { ok?: boolean }).ok !== false) {
        (out as Record<string, unknown>).drive = await copyToDrive(env, args.id);
      }
      return asMcpTextResult(out);
    }
  );

  // v1.74.0（2026-11-10 開発部・型の持ち帰り 便1）：成果の出た投稿のチャットで Naoki が「型にして」と言ったとき、AI が型・依頼パターンを候補として書き込む
  server.tool(
    "content_os__list_templates",
    "コンテンツくんの型（本文・締め・メモ・プロンプト・依頼パターン）を読む。型を書く前に、似た型がもう無いかを確かめるために使う。status＝mine（Naoki が自分で作った）／candidate（AI が書いた候補）／testing（検証中）／confirmed（確定）。query で名前・中身・なぜ効いたかを探す。一覧の中身は頭の 400 字、id を渡すと全文。戻り値: { ok, count, templates: [...] }。",
    {
      kind: z.enum(["body", "closing", "memo", "prompt", "request"]).optional().describe("型の種類。request＝依頼パターン（GPT へ図解・サムネ・本文を頼む文）"),
      status: z.enum(["mine", "candidate", "testing", "confirmed"]).optional(),
      query: z.string().max(100).optional(),
      id: z.string().optional().describe("型の番号（uuid）。渡すとその1件を全文で"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "list-templates", args))
  );

  server.tool(
    "content_os__save_template",
    "コンテンツくんに型・依頼パターンを「候補」として書き込む。使うのは、Naoki が成果の出た投稿のチャットで「これを型にして」「依頼パターンにして」と言ったときだけ（自分の判断で作らない）。型の読み書きは必ずこの道具と content_os__list_templates で行い、データベースの道具（Supabase など）で content_templates を直接書き換えない。新しく作ると必ず候補になり、Naoki が型の管理画面で使いながら確かめる。今ある型を直したいときは revise_id にその型の id を渡し「改訂案」の候補にする（元の型は Naoki が画面で「採用」を押すまで変わらない。種類・作るもの・名前は元の型を引き継ぐ）。id を渡すと、まだ候補のものだけ書き換えられる（Naoki の型は 409）。名前は中身が分かる名前にし、作るもの（引用の図解・記事内の図解・サムネ・本文の初稿）の名前をそのまま付けない（例：赤ペンメモ4枚図解）。made_in に、いま話しているチャットの住所（分かれば）を入れる。kind：body 本文の型（{{cursor}} の所にカーソルが来る）／closing 締め／memo メモ（- と半角スペース2つで箇条書き）／prompt AI に渡す文（{タイトル}{本文}{メモ}{種類} が書いている中身に置き換わる）／request 依頼パターン（make＝quote_figure 引用の図解／article_figure 記事内の図解／thumbnail サムネ／text 本文の初稿）。why（なぜ効いたか）は必須で、Naoki が言った主観と数字をその言葉のまま入れる。source_post_id は元の投稿の id（content_os__get_post で読める数字）。refs にスワイプくん（k=swipe）・思考整理くん（k=map）の id を 5 件まで付けると、依頼のたびに GPT へ渡る。書く前に content_os__list_templates で似た型が無いか確かめる。戻り値: { ok, created, template, revises, source_post }。",
    {
      id: z.string().optional().describe("書き換えるときだけ。まだ候補の型の番号（uuid）"),
      revise_id: z.string().optional().describe("今ある型を直す改訂案を作るとき、直す先の型の番号（uuid）"),
      made_in: z.string().max(300).optional().describe("どこで作ったか。チャットの住所（https://claude.ai/chat/… など）が分かればそれ、無ければ「claude.ai のチャット」など"),
      kind: z.enum(["body", "closing", "memo", "prompt", "request"]).optional().describe("新しく作るときは必須（revise_id のときは不要）"),
      name: z.string().max(120).optional().describe("型の名前（何に使う型か一目でわかる名前）。新しく作るときは必須"),
      content: z.string().max(20000).optional().describe("型の中身。新しく作るときは必須"),
      why: z.string().max(4000).optional().describe("なぜ効いたか（Naoki の言葉のまま・主観と数字）。新しく作るときは必須"),
      source_post_id: z.number().int().optional().describe("元の投稿の id"),
      make: z.enum(["quote_figure", "article_figure", "thumbnail", "text"]).optional().describe("kind=request のときの作るもの"),
      post_type: z.string().max(60).optional().describe("使う投稿の種類（x_post・x_article・note など）。省略ですべての種類"),
      refs: z.array(z.object({ k: z.enum(["swipe", "map"]), id: z.string(), title: z.string().max(120).optional() })).max(5).optional(),
      made_by: z.enum(["claude", "gpt"]).optional().describe("書いた AI。Claude は claude、ChatGPT は gpt（既定 claude）"),
    },
    async (args) => asMcpTextResult(await callContentOsInternalApi(env, "save-template", args))
  );

  // v1.73.0：予約の見回りを手で 1 回動かす（Claude の入口だけ。GPT の入口 /content/mcp には出さない）
  server.tool(
    "content_os__run_schedules",
    "コンテンツくんの予約の見回りを 1 回動かす（ふだんは 30 分ごとに自動）。①送信済みの投稿の X の住所を残す ②予約の依頼（未着手・引用元待ち）を Buffer に入れる。戻り値: { ok, x_urls: {count, seen, error?}, done, waiting, error, errors }。",
    {},
    async () => asMcpTextResult(await callContentOsInternalApi(env, "run-schedules", {}))
  );
}

// v1.80.0（2026-11-12 開発部・Naoki「進めて」12:11）：依頼の画像を Naoki のドライブへ写す。
// 置き方は コンテンツくん/2026-11/2026-11-14_題/引用図解/01.png …（X に手で入れるとき、ファイル選択から直接選べるように）。
// 書くのは zoom-to-youtube 第27版の ArchiveApi.saveContentImages（Naoki のふだんの Google の許可を持っているのがそちらのため）。
const DRIVE_SUB: Record<string, string> = { quote_figure: "引用図解", thumbnail: "サムネ", article_figure: "記事内図解" };
const IMG = /\.(png|jpe?g|webp|gif)(\?|$)/i;
async function copyToDrive(env: Env, id: string): Promise<unknown> {
  try {
    if (!env.ZOOM_ARCHIVE?.saveContentImages) return { ok: false, error: "zoom-to-youtube への結び（ZOOM_ARCHIVE）がありません" };
    const got = await callContentOsInternalApi<{ requests?: Array<Record<string, any>> }>(env, "list-requests", { id });
    const r = got?.requests?.[0];
    if (!r) return { ok: false, error: "依頼を読み直せませんでした" };
    const sub = DRIVE_SUB[String(r.kind)];
    if (!sub) return { ok: false, error: "画像を写す種類ではありません" };
    const images = (Array.isArray(r.result_urls) ? r.result_urls : [])
      .map((u: { url?: string }) => String(u?.url || ""))
      .filter((u: string) => /^https:\/\//.test(u) && IMG.test(u))
      .map((url: string) => ({ url }));
    if (!images.length) return { ok: false, error: "写す画像がありません" };
    return await env.ZOOM_ARCHIVE.saveContentImages({
      post_id: String(r.post_id),
      title: String(r.post?.title || "無題"),
      date: r.post?.datetime ? String(r.post.datetime) : null,
      sub,
      images,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// v1.81.0（2026-11-12 開発部）：GPT が作った画像を「ファイルのまま」受け取る口。
// 起きたこと：put_result の images（base64）では、GPT が 1600px の図解 4 枚を運べず、画像だけ書き戻せなかった（依頼 0e9b6b54・12:28）。
// ChatGPT は道具の入力に _meta["openai/fileParams"] を付けると、会話の中のファイルを { download_url, file_id } で渡してくる。
// こちらで download_url から読み、put-result へ base64 で渡す（サーバー同士なので大きさで詰まらない）。そのあとドライブへも写す。
// v1.123.0（2026-11-21 開発部）：1 枚ごとに drive_file_id（Google ドライブのファイルの番号）と at（本文の印の文字）を足した。
// download_url と drive_file_id のどちらか 1 つを渡す。at は投稿（post_id）のときだけ使える。
const OpenAIFile = z.object({
  download_url: z.string().optional().describe("ファイルの一時的な住所（ChatGPT が入れる）。drive_file_id を渡すときは省く"),
  file_id: z.string().optional().describe("ファイルの番号（ChatGPT が入れる）"),
  drive_file_id: z.string().optional().describe("Google ドライブのファイルの番号（https://drive.google.com/file/d/<この部分>/view）。download_url の代わりに渡すと、Naoki のドライブから直接読む"),
  at: z.string().max(200).optional().describe("投稿の本文の印の文字（例：「21.27.41」「うし部長さんの記事の引用」）。この文字を含む段落がちょうど 1 つあれば、末尾ではなくその段落のすぐ後ろへ入れる。同じ印に何枚か渡すと、渡した順に並ぶ"),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});
type InFile = { download_url?: string; file_id?: string; drive_file_id?: string; at?: string; mime_type?: string; file_name?: string };
function toB64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
// v1.120.0（2026-11-17 開発部・タスク「作った画像の保管」・Naoki OK 11:01）：
// 依頼（id）だけでなく投稿（post_id）にも画像を置けるようにし、20 枚まで受ける。
// GPT で作って X で直接予約した画像ポストを、コンテンツくんの投稿 1 行（正本）に残すため。ドライブは写し。
// 投稿へは content-os の put-post-images が本文の末尾へ画像として足す。読んで送るのは 4 枚ずつ（Worker の記憶の上限に当たらないように）。
const BATCH = 4;
const IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const DRIVE_ID = /^[0-9A-Za-z_-]{10,100}$/;
// v1.123.0：ドライブの画像を番号から読む。先に zoom-to-youtube（Naoki のふだんの Google の許可・drive.readonly）、
// だめなら共通のサービスアカウント（共有されたファイルだけ見える）。どちらもだめなら両方の理由を返す
async function readDrive(env: Env, id: string): Promise<{ data: ArrayBuffer; mime: string; name: string }> {
  if (!DRIVE_ID.test(id)) throw new Error("ドライブのファイルの番号の形ではありません");
  const why: string[] = [];
  if (env.ZOOM_ARCHIVE?.readDriveImage) {
    const r = (await env.ZOOM_ARCHIVE.readDriveImage(id)) as { ok?: boolean; data?: ArrayBuffer; mime?: string; name?: string; error?: string; message?: string };
    if (r?.ok && r.data) return { data: r.data, mime: String(r.mime || ""), name: String(r.name || "") };
    if (r?.error === "not_image" || r?.error === "too_big" || r?.error === "trashed") throw new Error(String(r.message || r.error));
    why.push(`ふだんの許可：${r?.message || r?.error || "読めません"}`);
  } else {
    why.push("ふだんの許可：zoom-to-youtube の readDriveImage がまだありません");
  }
  try {
    const tk = await getGoogleTokenForScope(env, "https://www.googleapis.com/auth/drive.readonly");
    const auth = { authorization: `Bearer ${tk}` };
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=${encodeURIComponent("name,mimeType,size")}&supportsAllDrives=true`, { headers: auth });
    if (!meta.ok) throw new Error(`Google ${meta.status}`);
    const m = (await meta.json()) as { name?: string; mimeType?: string };
    if (!IMG_TYPES.includes(String(m.mimeType))) throw new Error(`画像ではありません（${m.mimeType}）`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: auth });
    if (!res.ok) throw new Error(`Google ${res.status}`);
    return { data: await res.arrayBuffer(), mime: String(m.mimeType), name: String(m.name || "") };
  } catch (e) {
    why.push(`機械用の身分：${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`ドライブから読めません（${why.join("／")}）`);
}
// v1.124.0（2026-11-21 開発部・Naoki 12:44）：受け取ったものが本当に画像かを、先頭のバイトと Content-Type で確かめる。
// 違えば保存せずにその 1 枚を失敗にする。種類（png・jpeg…）も名前ではなく中身で決める。
// download_url がドライブの住所なら、番号を取り出してドライブから直接読む（非公開でも読める。公開しなくてよい）
async function readFile(env: Env, f: InFile, label: string) {
  const driveId = f.drive_file_id?.trim() || (f.download_url ? driveIdFromUrl(f.download_url) : null);
  if (driveId) {
    const d = await readDrive(env, driveId);
    if (d.data.byteLength > 8 * 1024 * 1024) throw new Error("8MB を超えています");
    const mime = sniffImage(d.data);
    if (!mime) throw new Error(`画像ではありません（ドライブの「${d.name || driveId}」の中身が png・jpeg・webp・gif ではない）`);
    return { base64: toB64(d.data), mime, label: label || d.name };
  }
  if (!/^https:\/\//.test(f.download_url || "")) throw new Error("download_url（https の住所）か drive_file_id を渡してください");
  const res = await fetch(f.download_url as string);
  if (!res.ok) throw new Error(`読めません（${res.status}）`);
  const ct = res.headers.get("content-type");
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) throw new Error("8MB を超えています");
  const mime = sniffImage(buf);
  if (!mime || typeSaysNotImage(ct)) {
    throw new Error(`画像ではありません（受け取ったのは ${String(ct || "種類なし").split(";")[0]}・${buf.byteLength} バイト。非公開のファイルの住所だとログイン画面が返ります。ドライブのファイルなら drive_file_id を渡してください）`);
  }
  return { base64: toB64(buf), mime, label: label || f.file_name || "" };
}
async function copyPostToDrive(env: Env, postId: string, images: string[]): Promise<unknown> {
  try {
    if (!env.ZOOM_ARCHIVE?.saveContentImages) return { ok: false, error: "zoom-to-youtube への結び（ZOOM_ARCHIVE）がありません" };
    const got = await callContentOsInternalApi<{ post?: Record<string, any> }>(env, "get-post", { id: postId });
    const p = got?.post;
    if (!p) return { ok: false, error: "投稿を読み直せませんでした" };
    if (!images.length) return { ok: false, error: "写す画像がありません" };
    return await env.ZOOM_ARCHIVE.saveContentImages({
      post_id: postId,
      title: String(p.title || "無題"),
      date: p.datetime ? String(p.datetime) : null,
      sub: "画像ポスト",
      images: images.map((url) => ({ url })),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
export function registerContentFileTool(server: McpServer, env: Env): void {
  (server as any).registerTool(
    "content_os__put_images",
    {
      description:
        "作った画像をファイルのまま、コンテンツくんの依頼か投稿へ置く（図解・サムネ・画像ポストなど。base64 にしなくてよい）。依頼なら id（依頼の番号 uuid）、投稿なら post_id（content_os__add_post で入れた投稿の番号）のどちらか 1 つを渡す。files に画像ファイルを 01・02… の順で 1〜20 枚（ChatGPT は download_url、Google ドライブにある画像は drive_file_id＝ファイルの番号を渡せば、非公開のままそのまま読んで置く。download_url にドライブの住所を入れても番号を取り出して読む）。中身が画像（png・jpeg・webp・gif）でないものは置かずに failed に数える。labels は各画像の題（同じ順）。replace_images=true で、前にこの道具で置いた画像を外して入れ直す。投稿へ置くと本文の末尾に画像として入り（files の各 1 枚に at＝本文の印の文字を付けると、その印の段落のすぐ後ろへ入る。印は「※画像：〜」の段落など、その文字を含む段落がちょうど 1 つのもの。1 つでも見つからなければ 1 枚も置かずに止まる。drop_markers=true で、入れ終わったあと印の段落を本文から外す）、Naoki のドライブ「コンテンツくん/月/日付_題/画像ポスト/」にも写る（依頼なら「…/引用図解・サムネ・記事内図解/」）。文の成果やステータスは別の道具で書く（この道具は画像だけ。ステータスは変えない）。戻り値: { ok, request? , post?, images?, drive, errors? }。",
      inputSchema: {
        id: z.string().optional().describe("依頼の番号（uuid）。投稿に置くときは省く"),
        post_id: z.union([z.string(), z.number()]).optional().describe("投稿の番号（content_os__add_post の post.id）。依頼に置くときは省く"),
        files: z.array(OpenAIFile).min(1).max(20).describe("画像ファイル（01 から順に・20 枚まで）"),
        labels: z.array(z.string().max(100)).max(20).optional(),
        replace_images: z.boolean().optional(),
        drop_markers: z.boolean().optional().describe("true なら、at で使った印の段落を、画像を入れ終わったあと本文から外す（読めない画像が 1 枚でもあれば外さない）。投稿のときだけ"),
      },
      _meta: { "openai/fileParams": ["files"] },
    },
    async (args: { id?: string; post_id?: string | number; files: InFile[]; labels?: string[]; replace_images?: boolean; drop_markers?: boolean }) => {
      const postId = args.post_id === undefined || args.post_id === "" ? "" : String(args.post_id);
      if (!!postId === !!args.id) return asMcpTextResult({ ok: false, error: "id（依頼）か post_id（投稿）のどちらか 1 つを渡してください" });
      const noSrc = args.files.map((f, i) => (!f.download_url && !f.drive_file_id ? i + 1 : 0)).filter(Boolean);
      if (noSrc.length) return asMcpTextResult({ ok: false, error: `${noSrc.join("・")} 枚目に download_url か drive_file_id がありません` });
      const ats = [...new Set(args.files.map((f) => String(f.at || "").trim()).filter(Boolean))];
      if (ats.length && !postId) return asMcpTextResult({ ok: false, error: "at（本文の印）は投稿（post_id）のときだけ使えます" });
      // v1.123.0：印は最初に全部まとめて下見する（4 枚ずつ送る途中で止まり、半分だけ入るのを防ぐ）
      if (ats.length) {
        const chk = await callContentOsInternalApi<{ ok?: boolean; markers?: { at: string; count: number }[]; error?: string }>(env, "put-post-images", { post_id: postId, check_markers: ats });
        if (!chk || chk.ok === false) return asMcpTextResult({ ok: false, error: "本文の印を確かめられませんでした", detail: chk });
        const bad = (chk.markers || []).filter((m) => m.count !== 1);
        if (bad.length) {
          return asMcpTextResult({
            ok: false,
            error: "本文の印がちょうど 1 つ見つからないものがあります（1 枚も置いていません）。0 件は文字の違い、2 件以上はもっと長い文字にしてください",
            markers: bad,
          });
        }
      }
      const errors: string[] = [];
      let keep: string | undefined;
      if (!postId) {
        const cur = await callContentOsInternalApi<{ requests?: Array<{ status?: string }> }>(env, "list-requests", { id: args.id });
        const status = cur?.requests?.[0]?.status;
        keep = status === "drafting" || status === "review" || status === "done" ? status : "review";
      }
      let out: Record<string, unknown> | null = null;
      let placed = 0;
      for (let s = 0; s < args.files.length; s += BATCH) {
        const images: { base64: string; mime?: string; label?: string; at?: string }[] = [];
        for (let i = s; i < Math.min(s + BATCH, args.files.length); i++) {
          const f = args.files[i];
          try {
            const im = await readFile(env, f, args.labels?.[i] || f.file_name || (f.drive_file_id ? "" : String(i + 1).padStart(2, "0")));
            images.push(f.at ? { ...im, at: String(f.at).trim() } : im);
          } catch (e) {
            errors.push(`${i + 1} 枚目：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (!images.length) continue;
        const replace = placed === 0 ? args.replace_images : false;
        const r = postId
          ? await callContentOsInternalApi<Record<string, unknown>>(env, "put-post-images", {
              post_id: postId,
              images,
              replace_images: replace,
              // 印を外すのは最後の回だけ・読めない画像が無いときだけ（印が残っていれば、どこが欠けたか本文で分かる）
              drop_markers: args.drop_markers && ats.length && s + BATCH >= args.files.length && !errors.length ? ats : undefined,
            })
          : await callContentOsInternalApi<Record<string, unknown>>(env, "put-result", { id: args.id, status: keep, images, replace_images: replace });
        if (!r || (r as { ok?: boolean }).ok === false) {
          errors.push(`${s + 1}〜${s + images.length} 枚目：${String((r as { message?: string; error?: string })?.message || (r as { error?: string })?.error || "書けませんでした")}`);
          break;
        }
        out = r;
        placed += images.length;
      }
      if (!out) return asMcpTextResult({ ok: false, error: "画像を 1 枚も置けませんでした", placed: 0, failed: args.files.length, errors });
      out.placed = placed;
      // v1.124.0：1 枚でも置けなければ ok は false（置けた分は残る・partial で知らせる）
      out.failed = args.files.length - placed;
      if (out.failed) { out.ok = false; out.partial = true; }
      out.drive = postId ? await copyPostToDrive(env, postId, (out.images as string[]) || []) : await copyToDrive(env, String(args.id));
      if (errors.length) out.errors = errors;
      return asMcpTextResult(out);
    }
  );
}
