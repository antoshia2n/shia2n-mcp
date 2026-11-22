import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pendingScores, setKind } from "./manager-score.js";
import { setFolder, tmOpen } from "./manager-folders.js";
import { censusOut, latestCensus, setPlan } from "./manager-census.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { STATES, workKey, areaName, linkUrl, normWorkState, workName, checkDone, checkPin, checkUpdate, chatOut, jstShort, normState, parseChatRef, parsePinRef, pickChats, pinNo, pinOut } from "./manager-core.js";
import { ManagerError, worksWithChats, addDone, addPin, attachWork, updateWork, workById, chatsByNos, lastPinTitles, listChats, pinFull, pinIndex, pinsByTitle, resolveChat, search, stateCounts, updateChat } from "./manager-store.js";
import { initiativePatch, sessionsFor, syncDecisionTask } from "./manager-links.js";
import { reportRequest, requestOut, requestsByState, submitRequest, workOfChat } from "./manager-run.js";

/**
 * マネージャーくんの道具（2026-11-21 v1.125.0 開発部・統括の依頼 1便目）。命名規約：manager__<action>
 * チャットを立てるのは ai_log__add（会話の最初の 1 回で台帳の行ができ、チャット番号が返る）。ここはその先の 6 本。
 *
 *   ・manager__pin：「これピン」で、その回答に題を付けて全文を残す。チャットの中で #1 から番号
 *   ・manager__update：状態（進行中・判断待ち・寝かせ中・閉じた）と「何をしているか」の 1 行を書き直す
 *   ・manager__search：題・1 行・ピンの全文から探す
 *   ・manager__get_pin：別のチャットから「○○のピン 3 を持ってきて」で全文を返す
 *   ・manager__waiting：判断待ちの一覧（統括が起動したときに読む）
 *   ・manager__list：台帳の一覧（状態・AI で絞る）
 *   ・manager__done（v1.128.0 4便目）：区切りごとに「○○をした」を 1 行残す。画面のチャットの時系列と「今日・今週やったこと」に出る
 * v1.129.0（5便目）：作業（分野 ＞ 作業 ＞ チャット）。manager__update の work でチャットを作業に入れ（同じ分野の開いている作業から同じ名前を探し、無ければ作る）、
 *   work_state で作業を済みにする。manager__done の link に PR の住所を添える
 * v1.128.0：ピンは題で呼ぶ（Naoki に番号を見せない）。分野（棚）は Claude・ChatGPT のプロジェクト名を拡張が入れる。manager__update の area で決めてもよい
 * 中身は src/manager-store.ts（読み書き）と src/manager-core.ts（計算だけ）。表は sql/manager.sql。
 */

const fail = (e: unknown) => {
  if (e instanceof ManagerError) return asMcpTextResult({ ok: false, code: e.code, message: e.message, ...e.extra });
  return asMcpTextResult({ ok: false, message: String((e as Error)?.message || e) });
};

const CHAT_DESC = "チャットの指し方：番号（ai_log__add が返したチャット番号。例 12）・チャットの住所・名前の一部（例 統括）のどれか";

export function registerManagerTools(server: McpServer, env: Env): void {

  // ─── 1. manager__pin ─────────────────────────────────────────────
  server.tool(
    "manager__pin",
    "Naoki が「これピン」「ピンして」と言ったら呼ぶ。直前のその回答に、あとで探すときの言葉で題を付け（Naoki が「26日7時でピン」のように題を言ったら、その言葉をそのまま題にする）、回答の全文をそのまま残す（要約しない・省かない）。chat はこのチャットの番号（会話の最初の ai_log__add が返したチャット番号）。番号はチャットの中で #1 から付くが、Naoki には番号を見せず「ピン：題」と、戻り値の リンク を押せる形で返す（あとで Naoki は題の言葉で呼ぶ）。戻り値: 成功 { ok: true, ピン: \"12#3\", チャット番号, 番号, 題, 作った, リンク }／失敗 { ok: false, code, message }。",
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      title: z.string().max(200).describe("ピンの題（120 字まで）。中身が一目でわかる言葉で"),
      body: z.string().max(200000).describe("回答の全文（そのまま全部。200,000 字まで）"),
    },
    async ({ chat, title, body }) => {
      try {
        const c = checkPin(title, body);
        if (!c.ok) return asMcpTextResult({ ok: false, code: "invalid_pin", message: c.message });
        const { chat: row } = await resolveChat(env, chat);
        const p = await addPin(env, Number(row.no), c.title, c.body);
        const o = pinOut(p, row);
        // v1.139.0：説明を覚え直していないチャットでも、返事にリンクが付くよう、戻り値の中で頼む
        return asMcpTextResult({ ok: true, ...o, 字数: c.body.length, 返事に書くこと: `「ピン：${o.題}」と、このリンクを押せる形で1行添える → ${o.リンク}` });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 2. manager__update ──────────────────────────────────────────
  server.tool(
    "manager__update",
    `このチャットの状態と「何をしているか」の 1 行を書き直す。状態は ${STATES.join("・")}。判断待ちにすると TaskMaster に「判断：チャットの名前」のタスクが立ち、判断待ちでなくなると済みになる。initiative で haAku の取り組みに結べる。呼ぶ場面：返事の最後で Naoki に判断を求めて止まるとき（state=判断待ち・doing に何を決めてほしいかを 1 行）／判断が返って作業に戻るとき（進行中）／しばらく置くとき（寝かせ中）／やり終えたとき（閉じた）。作業の中身が変わったら doing だけ直してよい。name（チャットの名前）と url（このチャットの住所）も直せる。area はこのチャットの分野（画面の棚の名前。ふつうは Claude・ChatGPT のプロジェクト名が自動で入るので、違うときだけ渡す）。work はこのチャットが入る作業の名前（同じ分野の開いている作業に同じ名前があればそこへ入り、無ければ新しく作る。ai_log__add が返した 開いている作業 に同じものがあれば、その名前をそのまま渡す。空文字で作業から外す）。work_state に「済み」を渡すと、このチャットの作業を済みにする（作業全体が終わったときだけ。ほかのチャットがまだ動いているなら渡さない）。戻り値: 成功 { ok: true, チャット: { 番号, 名前, AI, 状態, 何をしているか, 住所, ピンの数, 最後に触った } }／失敗 { ok: false, code, message }。`,
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      state: z.string().max(20).optional().describe(`状態：${STATES.join("・")}`),
      doing: z.string().max(200).optional().describe("何をしているか・何を決めてほしいかの 1 行（200 字まで）"),
      name: z.string().max(120).optional().describe("チャットの名前（120 字まで）"),
      url: z.string().max(500).optional().describe("このチャットの住所（https://…）。空文字で消す"),
      initiative: z.string().max(90).optional().describe("haAku の取り組み（2 桁の番号か名前）。空文字で外す"),
      area: z.string().max(60).optional().describe("分野（棚の名前・60 字まで）。空文字で外す"),
      work: z.string().max(80).optional().describe("このチャットが入る作業の名前（80 字まで）。空文字で作業から外す"),
      work_state: z.string().max(10).optional().describe("このチャットの作業の状態：済み か 進行中"),
    },
    async ({ chat, state, doing, name, url, initiative, area, work, work_state }) => {
      try {
        const ws = work_state === undefined || work_state === "" ? null : normWorkState(work_state);
        if (work_state && !ws) return asMcpTextResult({ ok: false, code: "invalid_work_state", message: "work_state は 済み か 進行中 です" });
        const c = state === undefined && doing === undefined && name === undefined && url === undefined && (initiative !== undefined || area !== undefined || work !== undefined || ws !== null)
          ? { ok: true as const, patch: {} as Record<string, string | null> }
          : checkUpdate({ state, doing, name, url });
        if (!c.ok) return asMcpTextResult({ ok: false, code: "invalid_update", message: c.message });
        const ini = await initiativePatch(env, initiative);
        if (!ini.ok) return asMcpTextResult({ ok: false, code: "invalid_initiative", message: ini.message });
        const { chat: row } = await resolveChat(env, chat);
        const ar = area === undefined ? {} : areaName(area) ? { area: areaName(area), area_src: "チャット" } : { area: null, area_src: null };
        let after = await updateChat(env, Number(row.no), { ...c.patch, ...ini.patch, ...ar });
        // v1.129.0：作業に入れる・作業を済みにする
        let workNote: Record<string, unknown> = {};
        if (work !== undefined) {
          const r = await attachWork(env, after, workName(work));
          after = r.chat;
          if (r.work) workNote = { 作業: { 番号: Number(r.work.id), 名前: r.work.name, 新しく作った: r.created } };
        }
        if (ws && after.work_id) {
          const w = await updateWork(env, Number(after.work_id), { state: ws });
          after = { ...after, work: { id: w.id, name: w.name, state: w.state } };
        }
        // v1.127.0：判断待ちになったら TaskMaster に「判断：…」、外れたら済みに
        const t = await syncDecisionTask(env, after);
        if (t.action !== "none") after = { ...after, tm_task_id: t.action === "added" ? t.task_id : null };
        return asMcpTextResult({ ok: true, チャット: chatOut(after), ...workNote, ...(t.error ? { warnings: [`TaskMaster：${t.error}`] } : {}) });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 3. manager__search ──────────────────────────────────────────
  server.tool(
    "manager__search",
    "台帳を探す（読むだけ）。チャットの名前・何をしているか・役割と、ピンの題と全文から、言葉を全部含むものを返す（空白で区切ると全部を含むもの）。ピンは題に当たったものが先、あとは新しい順。全文が要るときは返った 題 を manager__get_pin の q に渡す（ピン の値を ref に渡してもよい）。Naoki には題で見せ、番号は見せない。戻り値: { ok: true, 件数, 一覧: [{ 種類: チャット|ピン, ピン?, チャット番号, 題, チャットの名前, 状態, 抜き出し, 日時 }] }／失敗 { ok: false, message }。0 件は ok: true で 件数 0。",
    {
      q: z.string().min(1).max(200).describe("探す言葉（空白で区切ると全部を含むもの）"),
      limit: z.number().int().min(1).max(100).optional().describe("最大件数（既定 30）"),
    },
    async ({ q, limit }) => {
      try {
        const rows = await search(env, q, limit ?? 30);
        return asMcpTextResult({
          ok: true, 件数: rows.length,
          一覧: rows.map((r) => ({
            種類: r.kind === "pin" ? "ピン" : "チャット",
            ...(r.kind === "pin" ? { ピン: `${r.chat_no}#${r.pin_n}` } : {}),
            チャット番号: Number(r.chat_no), 題: r.title, チャットの名前: r.chat_name, 状態: r.state,
            抜き出し: String(r.snippet ?? ""), 日時: jstShort(r.at),
          })),
        });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 4. manager__get_pin ─────────────────────────────────────────
  server.tool(
    "manager__get_pin",
    "ピンの全文を取ってくる（読むだけ）。Naoki が「○○のピンを持ってきて」と言ったら、その言葉を q に渡す（ピンの題から探す。空白で区切ると全部を含むもの）。題がそのまま一致するものが先、あとは新しいピンを選び、ほかに当たったものを 候補（題・チャットの名前・作った）で返す。違えば候補の 題 で呼び直す。番号で呼ぶとき（manager__search が返した ピン の値など）は ref に「12#3」、または chat と pin を渡す。chat だけで pin を省くと、そのチャットのピンの目次を返す（chat の言葉を名前に含むチャットが無ければ、ピンの題から探す）。返った全文はそのまま使い、勝手に縮めない。Naoki には題で見せ、番号は見せない。戻り値: 成功 { ok: true, ピン, チャット番号, 番号, 題, 作った, チャットの名前, チャットの住所, 全文, 字数, 候補? } か { ok: true, チャット, 目次: [{ ピン, 題, 作った }] }／失敗 { ok: false, code, message }。",
    {
      q: z.string().max(200).optional().describe("ピンの題の言葉（例「配信まとめ」）。いちばんよく使う呼び方"),
      ref: z.string().max(100).optional().describe("「12#3」の形（チャット番号#ピン番号）"),
      chat: z.string().max(500).optional().describe(CHAT_DESC),
      pin: z.string().max(20).optional().describe("ピンの番号（例 3）。省くと目次"),
    },
    async ({ q, ref, chat, pin }) => {
      try {
        let chatRef: string | undefined = chat;
        let n: number | null = pin !== undefined && pin !== "" ? pinNo(pin) : null;
        if (pin !== undefined && pin !== "" && n === null) return asMcpTextResult({ ok: false, code: "invalid_pin", message: `pin は番号です（受け取った値：${pin}）` });
        let words = q && q.trim() ? q.trim() : null;
        if (ref) {
          const r = parsePinRef(ref);
          if (r && r.chat) { chatRef = r.chat; n = r.n; }
          else if (!words) words = ref; // 番号の形でなければ題の言葉として探す
          else return asMcpTextResult({ ok: false, code: "invalid_ref", message: `ref は「12#3」の形です（受け取った値：${ref}）` });
        }
        // v1.128.1：q が見えていない呼び手（古い形の道具を持つチャット）が chat に題の言葉を入れても取れるように、
        // pin が無く、番号でも住所でもなく、その言葉の名前のチャットが無いときは、ピンの題から探す
        if (!words && chatRef && n === null) {
          const r = parseChatRef(chatRef);
          if (r && "words" in r) {
            const named = pickChats(await listChats(env, { state: "すべて", limit: 300 }), r.words);
            if (!named.length) { words = chatRef; chatRef = undefined; }
          }
        }
        if (words && !chatRef) {
          const hits = await pinsByTitle(env, words, 8);
          if (!hits.length) return asMcpTextResult({ ok: false, code: "pin_not_found", message: `題に「${words}」を含むピンはありません。manager__search で全文からも探せます` });
          const chats = await chatsByNos(env, hits.map((h) => Number(h.chat_no)));
          const byNo = new Map(chats.map((c) => [Number(c.no), c]));
          const top = hits[0];
          const p = await pinFull(env, Number(top.chat_no), Number(top.n));
          if (!p) return asMcpTextResult({ ok: false, code: "pin_not_found", message: "ピンを読めませんでした" });
          const row = byNo.get(Number(top.chat_no)) ?? null;
          const 候補 = hits.slice(1).map((h) => ({ 題: h.title, チャットの名前: byNo.get(Number(h.chat_no))?.name ?? "", 作った: jstShort(h.created_at), ピン: `${h.chat_no}#${h.n}` }));
          const ses = row ? await sessionsFor(env, row.url) : [];
          return asMcpTextResult({ ok: true, ...pinOut(p, row, true), ...(ses.length ? { Notion_Sessions: ses } : {}), ...(候補.length ? { 候補 } : {}) });
        }
        if (!chatRef) return asMcpTextResult({ ok: false, code: "invalid_chat", message: "q（題の言葉）か、ref か chat を渡してください" });
        const { chat: row, others } = await resolveChat(env, chatRef, n);
        const 候補 = others.map((o) => ({ 番号: Number(o.no), 名前: o.name, ピンの数: Number(o.pin_count || 0), 最後に触った: chatOut(o).最後に触った }));
        if (n === null) {
          const idx = await pinIndex(env, Number(row.no));
          return asMcpTextResult({ ok: true, チャット: chatOut(row), 目次: idx.map((p) => ({ ピン: `${p.chat_no}#${p.n}`, 題: p.title, 作った: pinOut(p).作った })), ...(候補.length ? { 候補 } : {}) });
        }
        const p = await pinFull(env, Number(row.no), n);
        if (!p) return asMcpTextResult({ ok: false, code: "pin_not_found", message: `チャット ${row.no}（${row.name}）にピン ${n} はありません（ピンは ${row.pin_count} 個）`, ...(候補.length ? { 候補 } : {}) });
        const ses = await sessionsFor(env, row.url);
        return asMcpTextResult({ ok: true, ...pinOut(p, row, true), ...(ses.length ? { Notion_Sessions: ses } : {}), ...(候補.length ? { 候補 } : {}) });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 5. manager__waiting ─────────────────────────────────────────
  server.tool(
    "manager__waiting",
    "判断待ちのチャットの一覧と、Naoki がまだ評価していない作業の一覧（読むだけ）。統括が起動したときに最初に読む。各行に、何を決めてほしいか（何をしているか）・住所・最後のピンの題が付く。古く待たせているものが上。評価待ち は、済んだ依頼か、型の付いた完了した作業で、クオリティと仕組みの評価がまだのもの（作業ごと・型つき・古い順）。統括は件数を Naoki に知らせ、住所を開いて評価してもらう。戻り値: { ok: true, 件数, 一覧: [{ 番号, 名前, AI, 何をしているか, 住所, 最後に触った, 最後のピン? }], 評価待ちの件数, 評価待ち: [{ 作業番号, 作業, 型, フォルダ, 待っている数, 依頼: [{ 番号, 題, 済んだ }], 作業ごと評価, 待ちはじめ, 住所 }], 状態ごと }／失敗 { ok: false, message }。",
    {},
    async () => {
      try {
        const rows = (await listChats(env, { state: "判断待ち", limit: 200 })).reverse();
        const last = await lastPinTitles(env, rows.map((r) => Number(r.no)));
        const counts = await stateCounts(env);
        const oks = await requestsByState(env, ["OK待ち"]).catch(() => []);
        const ps = await pendingScores(env).catch(() => []);
        return asMcpTextResult({
          ok: true, 件数: rows.length,
          ...(oks.length ? { OK待ちの依頼: oks.map((x) => ({ 番号: Number(x.req.id), 作業: x.work?.name ?? "", 題: x.req.title, 住所: `https://manager.shia2n.jp/#r${x.req.id}` })) } : {}),
          一覧: rows.map((r) => { const o = chatOut(r); const lp = last[Number(r.no)]; return { 番号: o.番号, 名前: o.名前, AI: o.AI, 何をしているか: o.何をしているか, 住所: o.住所, 最後に触った: o.最後に触った, ...(lp ? { 最後のピン: `${r.no}#${lp.n} ${lp.title}` } : {}) }; }),
          評価待ちの件数: ps.reduce((a, x) => a + x.reqs.length + (x.whole ? 1 : 0), 0),
          評価待ち: ps.map((x) => ({
            作業番号: Number(x.work.id), 作業: String(x.work.name ?? ""), 型: x.work.kind ? String(x.work.kind) : null,
            フォルダ: x.work.tm_project_name ? String(x.work.tm_project_name) : null,
            待っている数: x.reqs.length + (x.whole ? 1 : 0),
            依頼: x.reqs.map((r) => ({ 番号: Number(r.id), 題: String(r.title ?? ""), 済んだ: jstShort(r.done_at) })),
            作業ごと評価: x.whole, 待ちはじめ: jstShort(x.since), 住所: `https://manager.shia2n.jp/#w${x.work.id}`,
          })),
          状態ごと: counts,
        });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 6. manager__list ────────────────────────────────────────────
  server.tool(
    "manager__list",
    `台帳の一覧（読むだけ）。最後に触った順。state を省くと閉じた以外、「すべて」で全部。ai は claude か gpt。area で分野（棚）を絞る（「未分類」で分野の空のもの）。自分のチャット番号を忘れたときもここで探す。戻り値: { ok: true, 件数, 一覧: [{ 番号, 名前, AI, 状態, 何をしているか, 住所, 役割, 分野, ピンの数, 最後に触った, 作った }] }／失敗 { ok: false, message }。`,
    {
      state: z.string().max(20).optional().describe(`${STATES.join("・")}・すべて（省くと閉じた以外）`),
      ai: z.string().max(10).optional().describe("claude か gpt"),
      limit: z.number().int().min(1).max(300).optional().describe("最大件数（既定 50）"),
      area: z.string().max(60).optional().describe("分野（棚の名前）。「未分類」で分野の空のもの"),
    },
    async ({ state, ai, limit, area }) => {
      try {
        let st: string | null = null;
        if (state && state.trim()) {
          if (state.trim() === "すべて") st = "すべて";
          else { st = normState(state); if (!st) return asMcpTextResult({ ok: false, message: `state は ${STATES.join("・")}・すべて のどれかです` }); }
        }
        const a = ai ? ai.trim().toLowerCase().replace("chatgpt", "gpt") : null;
        if (a && a !== "claude" && a !== "gpt") return asMcpTextResult({ ok: false, message: "ai は claude か gpt です" });
        const rows = await listChats(env, { state: st, ai: a, limit: limit ?? 50, area: areaName(area) });
        return asMcpTextResult({ ok: true, 件数: rows.length, 一覧: rows.map(chatOut) });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 7. manager__done（v1.128.0 4便目） ──────────────────────────
  server.tool(
    "manager__done",
    "このチャットでやったことを 1 行残す。ひとまとまりの作業が終わった区切りごとに 1 回呼ぶ（例：本番に出した・案を出して決めてもらった・調べて結論を出した）。text は「○○をした」の形で、あとで Naoki が一覧で読んで何をやったか分かる言葉で（200 字まで）。PR を作った・出したときは link にその住所を添える（作業の画面に PR として並ぶ）。マネージャーくんの画面で、チャットの時系列と「今日・今週やったこと」に並ぶ。返事の中で残したことを言う必要はない。戻り値: 成功 { ok: true, チャット番号, やったこと, 時刻 }／失敗 { ok: false, code, message }。",
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      text: z.string().max(400).describe("やったことの 1 行（「○○をした」・200 字まで）"),
      link: z.string().max(500).optional().describe("添える住所（PR など・https://…）"),
    },
    async ({ chat, text, link }) => {
      try {
        const d = checkDone(text);
        if (!d.ok) return asMcpTextResult({ ok: false, code: "invalid_done", message: d.message });
        const l = linkUrl(link);
        if (!l.ok) return asMcpTextResult({ ok: false, code: "invalid_link", message: l.message });
        const { chat: row } = await resolveChat(env, chat);
        const r = await addDone(env, Number(row.no), d.text, l.url);
        return asMcpTextResult({ ok: true, チャット番号: Number(row.no), やったこと: r.row.text, ...(r.row.link ? { 住所: r.row.link } : {}), 時刻: jstShort(r.row.at) });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 8. manager__work（v1.129.0 5便目） ──────────────────────────
  // 前からある道具に足した欄が、つないだままのチャットに見えないことがあった（2026-11-22 の確かめ）ので、作業は新しい道具 1 本でも扱えるようにする
  server.tool(
    "manager__work",
    "このチャットを作業に入れる・作業を済みにする・PR を作業に残す。作業は「マネージャーくん」「るーみんの LP 直し」のような仕事のまとまりで、画面の棚では 分野 ＞ 作業 ＞ チャット と並ぶ。name：このチャットが入る作業の名前（同じ分野の開いている作業に同じ名前があればそこへ入り、無ければ新しく作る。ai_log__add が返した 開いている作業 に同じものがあれば、その名前をそのまま渡す。空文字で作業から外す）。state：「済み」で作業を済みにする（作業全体が終わったときだけ。ほかのチャットがまだ動いているなら渡さない）、「進行中」で戻す。pr：PR を作ったら住所を渡す（作業の画面に PR として並び、やったことにも 1 行残る）。kind：作業の型（仕事の種類。例「X のポスト作成」「LP の直し」「アプリの便」）。作業を決めたときに 1 度渡す（Naoki の評価が型ごとにたまり、両方 100 点の型は自動で実行に上がる）。folder：作業のフォルダ＝TaskMaster のプロジェクトの名前（例「計画」）。名前が 1 つに当たればフォルダが決まり、TaskMaster にその作業のタスクが立つ（もうタスクがあればプロジェクトを移す）。0 件か 2 件以上に当たったら何も変えずに 候補 を返すので、候補の名前で渡し直す。空文字でフォルダを外す。チャットの area（部屋の札）とは別物。戻り値: 成功 { ok: true, チャット番号, 作業: { 番号, 名前, 状態, 型, フォルダ, タスク, 新しく作った? } | null }／失敗 { ok: false, code, message, 候補? }。",
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      name: z.string().max(80).optional().describe("作業の名前（80 字まで）。空文字で作業から外す"),
      state: z.string().max(10).optional().describe("済み か 進行中"),
      pr: z.string().max(500).optional().describe("PR の住所（https://github.com/…/pull/…）"),
      pr_title: z.string().max(200).optional().describe("PR で何をしたかの 1 行（省くと「PR を出した」）"),
      kind: z.string().max(60).optional().describe("作業の型（仕事の種類・60 字まで）"),
      folder: z.string().max(120).optional().describe("フォルダ＝TaskMaster のプロジェクトの名前。空文字で外す"),
    },
    async ({ chat, name, state, pr, pr_title, kind, folder }) => {
      try {
        const ws = state === undefined || state === "" ? null : normWorkState(state);
        if (state && !ws) return asMcpTextResult({ ok: false, code: "invalid_work_state", message: "state は 済み か 進行中 です" });
        const l = linkUrl(pr);
        if (!l.ok) return asMcpTextResult({ ok: false, code: "invalid_link", message: l.message });
        if (name === undefined && !ws && !l.url && kind === undefined && folder === undefined) return asMcpTextResult({ ok: false, code: "nothing", message: "name・state・pr・kind・folder のどれかを渡してください" });
        // v1.144.0：フォルダは先に名前を当てる（当たらなければ何も変えずに候補を返す）
        let projectId: string | null | undefined;
        if (folder !== undefined) {
          if (!folder.trim()) projectId = null;
          else {
            const { projects } = await tmOpen(env);
            const k = workKey(folder);
            const exact = projects.filter((p) => String(p.title ?? "").trim() === folder.trim());
            const hits = exact.length ? exact : projects.filter((p) => workKey(p.title) === k);
            if (hits.length !== 1) {
              const near = projects.filter((p) => { const t = workKey(p.title); return k && (t.includes(k) || k.includes(t)); });
              return asMcpTextResult({ ok: false, code: hits.length ? "folder_ambiguous" : "folder_not_found", message: hits.length ? `「${folder}」という名前の TaskMaster のプロジェクトが ${hits.length} つあります。何も変えていません` : `「${folder}」という TaskMaster のプロジェクトがありません。何も変えていません。候補の名前で渡し直してください`, 候補: (near.length ? near : projects).map((p) => String(p.title ?? "")).slice(0, 40) });
            }
            projectId = String(hits[0].id);
          }
        }
        let { chat: row } = await resolveChat(env, chat);
        let created: boolean | undefined;
        if (name !== undefined) { const r = await attachWork(env, row, workName(name)); row = r.chat; created = r.work ? r.created : undefined; }
        if (l.url) {
          const d = checkDone(pr_title || "PR を出した");
          await addDone(env, Number(row.no), d.ok ? d.text : "PR を出した", l.url);
        }
        let w = row.work_id ? await workById(env, Number(row.work_id)) : null;
        if (kind !== undefined && w) w = await setKind(env, Number(w.id), kind); // v1.136.0
        if (projectId !== undefined) {
          if (!w) return asMcpTextResult({ ok: false, code: "no_work", message: "このチャットはまだ作業に入っていません。name で作業を決めてから folder を渡してください" });
          w = await setFolder(env, Number(w.id), projectId);
        }
        if (ws) {
          if (!w) return asMcpTextResult({ ok: false, code: "no_work", message: "このチャットはまだ作業に入っていません。name で作業を決めてください" });
          w = await updateWork(env, Number(w.id), { state: ws });
        }
        return asMcpTextResult({ ok: true, チャット番号: Number(row.no), 作業: w ? { 番号: Number(w.id), 名前: w.name, 状態: w.state, 型: w.kind ?? null, フォルダ: w.tm_project_name ?? null, タスク: w.tm_task_id ? `https://taskmaster.shia2n.jp/?task=${encodeURIComponent(String(w.tm_task_id))}` : null, ...(created !== undefined ? { 新しく作った: created } : {}) } : null });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 8b. manager__tabs（v1.145.0 タブの棚卸し） ───────────────────
  server.tool(
    "manager__tabs",
    "タブの棚卸しを読む・整理案を出す（統括が使う）。Naoki がパネルのタブの画面で「棚卸しを統括へ送る」を押すと、Chrome の全ウィンドウのタブ（番号・画面・まとまり・題・住所）が 1 回分残る。引数なしで呼ぶと、その棚卸しと、開いている作業の一覧（番号・名前・フォルダ・型）と、フォルダ（TaskMaster のプロジェクト）の名前が返る。整理案を出すときは items と close を渡す：items は [{ tabs: [タブの番号…], work_id: 入れる作業の番号 }] か、新しい作業なら [{ tabs, new_work: \"作業の名前\", folder: \"フォルダの名前\" }]。close は閉じてよいタブの番号（調べ終えた検索結果・重なったページなど）。note は Naoki に向けた一言（なぜこう分けたか）。どこにも入れず閉じもしないタブは、そのまま残る。案を出すだけでタブは動かない。Naoki がパネルで案を見て「この案で並べる」を押したときに初めて並ぶ。返事では、案を出したことと、パネルのタブの画面で確かめて押してほしいことを Naoki に書く。戻り値: { ok: true, 棚卸し: { 送った, タブの数, タブ: [...], 整理案, 並べ終えた }, 開いている作業?, フォルダ?, 返事に書くこと? }／失敗 { ok: false, code, message }。",
    {
      items: z.array(z.object({
        tabs: z.array(z.number().int().positive()).max(300).describe("このまとまりに入れるタブの番号"),
        work_id: z.number().int().positive().optional().describe("入れる作業の番号（開いている作業）"),
        new_work: z.string().max(80).optional().describe("新しい作業の名前（work_id が無いとき）"),
        folder: z.string().max(120).optional().describe("新しい作業のフォルダ＝TaskMaster のプロジェクトの名前"),
      })).max(60).optional().describe("振り分け"),
      close: z.array(z.number().int().positive()).max(300).optional().describe("閉じてよいタブの番号"),
      note: z.string().max(1000).optional().describe("Naoki に向けた一言"),
    },
    async ({ items, close, note }) => {
      try {
        if (items === undefined && close === undefined) {
          const c = await latestCensus(env);
          if (!c) return asMcpTextResult({ ok: false, code: "no_census", message: "棚卸しがまだありません。Naoki にパネルのタブの画面で「棚卸しを統括へ送る」を押してもらってください" });
          const [ws, tm] = await Promise.all([worksWithChats(env), tmOpen(env).catch(() => ({ projects: [] as any[] }))]);
          return asMcpTextResult({ ok: true, 棚卸し: censusOut(c),
            開いている作業: ws.map((x) => ({ 番号: Number(x.work.id), 名前: String(x.work.name), フォルダ: x.work.tm_project_name ?? null, 型: x.work.kind ?? null })),
            フォルダ: tm.projects.map((p) => String(p.title)) });
        }
        const r = await setPlan(env, { items: items ?? [], close: close ?? [], note });
        return asMcpTextResult({ ok: true, 棚卸し: censusOut(r.row),
          返事に書くこと: `整理案を出しました（振り分け ${r.plan.items.length} つ・閉じる ${r.plan.close.length} 本）。パネルのタブの画面の上に案が出ているので、見て「この案で並べる」を押してください。` });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 9. manager__propose（v1.131.0 6便目） ──────────────────────
  server.tool(
    "manager__propose",
    "このチャットの作業に「依頼」を 1 件出す（実行係＝Claude Code のルーティンに任せる仕事）。作業の段階が 1 なら Naoki の OK を待ち（TaskMaster に「OK待ち：…」が立つ）、2 ならそのまま実行係が動き、0 なら控えとして残るだけ。出す前に、このチャットが作業に入っていること（manager__work の name）。title は何をするかの 1 行、body は実行係が読んで迷わない中身（目的・やること・終わりの形）、why はなぜ、stop は止める条件（これに当たったら実行係は止まって報告する）、recipe は使うレシピの名前（決めていれば）。Naoki が「これ任せて」「実行係に回して」と言ったとき、または段階 2 の作業で次の手が決まったときに呼ぶ。勝手に何件も出さない（同じ作業で同時に動くのは 1 つ）。戻り値: 成功 { ok: true, 依頼: { 番号, 作業, 題, 状態, … }, 実行?: { ok, session_url?, message } }／失敗 { ok: false, code, message }。",
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      title: z.string().max(200).describe("何をするかの 1 行（120 字まで）"),
      body: z.string().max(20000).optional().describe("実行係が読む中身（目的・やること・終わりの形）"),
      why: z.string().max(1000).optional().describe("なぜ"),
      stop: z.string().max(1000).optional().describe("止める条件"),
      recipe: z.string().max(120).optional().describe("使うレシピの名前（決めていれば）"),
    },
    async ({ chat, title, body, why, stop, recipe }) => {
      try {
        const { chat: row } = await resolveChat(env, chat);
        const work = await workOfChat(env, Number(row.no));
        if (!work) return asMcpTextResult({ ok: false, code: "no_work", message: "このチャットはまだ作業に入っていません。先に manager__work の name で作業を決めてください" });
        const r = await submitRequest(env, Number(work.id), { title, body, why, stop, recipe }, { source: "チャット", from_chat_no: Number(row.no) });
        return asMcpTextResult({ ok: true, 依頼: requestOut(r.req, work), ...(r.fired ? { 実行: r.fired } : {}), 住所: `https://manager.shia2n.jp/#r${r.req.id}` });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 10. manager__report（v1.131.0 6便目） ──────────────────────
  server.tool(
    "manager__report",
    "実行係（マネージャーくんの依頼で起きたセッション）が、依頼の結果を返す。終えたら state=済み、止める条件に当たった・判断が要る・続けられないときは state=止まった。result は Naoki が読んで分かる結果の数行（何をしたか・どこを見ればいいか・止まったなら何を決めてほしいか）。PR を出したら pr に住所と pr_title。呼ぶと依頼が閉じ、同じ作業の次の順番待ちが動く。依頼番号は届いた依頼の文の「依頼番号」。戻り値: 成功 { ok: true, 依頼: { 番号, 状態, … }, 次?: { ok, message } }／失敗 { ok: false, code, message }。",
    {
      request: z.number().int().positive().describe("依頼番号"),
      state: z.string().max(10).describe("済み か 止まった"),
      result: z.string().min(1).max(4000).describe("結果（数行）"),
      pr: z.string().max(500).optional().describe("PR の住所"),
      pr_title: z.string().max(200).optional().describe("PR で何をしたかの 1 行"),
    },
    async ({ request, state, result, pr, pr_title }) => {
      try {
        const st = /止|stop|fail|block/i.test(state) ? "止まった" : /済|完了|done|ok/i.test(state) ? "済み" : null;
        if (!st) return asMcpTextResult({ ok: false, code: "invalid_state", message: "state は 済み か 止まった です" });
        const l = linkUrl(pr);
        if (!l.ok) return asMcpTextResult({ ok: false, code: "invalid_link", message: l.message });
        const r = await reportRequest(env, request, { state: st, result, pr: l.url, pr_title: pr_title ?? null });
        return asMcpTextResult({ ok: true, 依頼: requestOut(r.req), ...(r.next ? { 次: r.next } : {}) });
      } catch (e) { return fail(e); }
    }
  );
}
