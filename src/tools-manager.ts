import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { STATES, areaName, checkDone, checkPin, checkUpdate, chatOut, jstShort, normState, parseChatRef, parsePinRef, pickChats, pinNo, pinOut } from "./manager-core.js";
import { ManagerError, addDone, addPin, chatsByNos, lastPinTitles, listChats, pinFull, pinIndex, pinsByTitle, resolveChat, search, stateCounts, updateChat } from "./manager-store.js";
import { initiativePatch, sessionsFor, syncDecisionTask } from "./manager-links.js";

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
    "Naoki が「これピン」「ピンして」と言ったら呼ぶ。直前のその回答に、あとで探すときの言葉で題を付け、回答の全文をそのまま残す（要約しない・省かない）。chat はこのチャットの番号（会話の最初の ai_log__add が返したチャット番号）。番号はチャットの中で #1 から付くが、Naoki には番号を見せず「ピン：題」の形で返す（あとで Naoki は題の言葉で呼ぶ）。戻り値: 成功 { ok: true, ピン: \"12#3\", チャット番号, 番号, 題, 作った }／失敗 { ok: false, code, message }。",
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
        return asMcpTextResult({ ok: true, ...pinOut(p, row), 字数: c.body.length });
      } catch (e) { return fail(e); }
    }
  );

  // ─── 2. manager__update ──────────────────────────────────────────
  server.tool(
    "manager__update",
    `このチャットの状態と「何をしているか」の 1 行を書き直す。状態は ${STATES.join("・")}。判断待ちにすると TaskMaster に「判断：チャットの名前」のタスクが立ち、判断待ちでなくなると済みになる。initiative で haAku の取り組みに結べる。呼ぶ場面：返事の最後で Naoki に判断を求めて止まるとき（state=判断待ち・doing に何を決めてほしいかを 1 行）／判断が返って作業に戻るとき（進行中）／しばらく置くとき（寝かせ中）／やり終えたとき（閉じた）。作業の中身が変わったら doing だけ直してよい。name（チャットの名前）と url（このチャットの住所）も直せる。area はこのチャットの分野（画面の棚の名前。ふつうは Claude・ChatGPT のプロジェクト名が自動で入るので、違うときだけ渡す）。戻り値: 成功 { ok: true, チャット: { 番号, 名前, AI, 状態, 何をしているか, 住所, ピンの数, 最後に触った } }／失敗 { ok: false, code, message }。`,
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      state: z.string().max(20).optional().describe(`状態：${STATES.join("・")}`),
      doing: z.string().max(200).optional().describe("何をしているか・何を決めてほしいかの 1 行（200 字まで）"),
      name: z.string().max(120).optional().describe("チャットの名前（120 字まで）"),
      url: z.string().max(500).optional().describe("このチャットの住所（https://…）。空文字で消す"),
      initiative: z.string().max(90).optional().describe("haAku の取り組み（2 桁の番号か名前）。空文字で外す"),
      area: z.string().max(60).optional().describe("分野（棚の名前・60 字まで）。空文字で外す"),
    },
    async ({ chat, state, doing, name, url, initiative, area }) => {
      try {
        const c = state === undefined && doing === undefined && name === undefined && url === undefined && (initiative !== undefined || area !== undefined)
          ? { ok: true as const, patch: {} as Record<string, string | null> }
          : checkUpdate({ state, doing, name, url });
        if (!c.ok) return asMcpTextResult({ ok: false, code: "invalid_update", message: c.message });
        const ini = await initiativePatch(env, initiative);
        if (!ini.ok) return asMcpTextResult({ ok: false, code: "invalid_initiative", message: ini.message });
        const { chat: row } = await resolveChat(env, chat);
        const ar = area === undefined ? {} : areaName(area) ? { area: areaName(area), area_src: "チャット" } : { area: null, area_src: null };
        let after = await updateChat(env, Number(row.no), { ...c.patch, ...ini.patch, ...ar });
        // v1.127.0：判断待ちになったら TaskMaster に「判断：…」、外れたら済みに
        const t = await syncDecisionTask(env, after);
        if (t.action !== "none") after = { ...after, tm_task_id: t.action === "added" ? t.task_id : null };
        return asMcpTextResult({ ok: true, チャット: chatOut(after), ...(t.error ? { warnings: [`TaskMaster：${t.error}`] } : {}) });
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
    "判断待ちのチャットの一覧（読むだけ）。統括が起動したときに最初に読む。各行に、何を決めてほしいか（何をしているか）・住所・最後のピンの題が付く。古く待たせているものが上。戻り値: { ok: true, 件数, 一覧: [{ 番号, 名前, AI, 何をしているか, 住所, 最後に触った, 最後のピン? }], 状態ごと }／失敗 { ok: false, message }。",
    {},
    async () => {
      try {
        const rows = (await listChats(env, { state: "判断待ち", limit: 200 })).reverse();
        const last = await lastPinTitles(env, rows.map((r) => Number(r.no)));
        const counts = await stateCounts(env);
        return asMcpTextResult({
          ok: true, 件数: rows.length,
          一覧: rows.map((r) => { const o = chatOut(r); const lp = last[Number(r.no)]; return { 番号: o.番号, 名前: o.名前, AI: o.AI, 何をしているか: o.何をしているか, 住所: o.住所, 最後に触った: o.最後に触った, ...(lp ? { 最後のピン: `${r.no}#${lp.n} ${lp.title}` } : {}) }; }),
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
    "このチャットでやったことを 1 行残す。ひとまとまりの作業が終わった区切りごとに 1 回呼ぶ（例：本番に出した・案を出して決めてもらった・調べて結論を出した）。text は「○○をした」の形で、あとで Naoki が一覧で読んで何をやったか分かる言葉で（200 字まで）。マネージャーくんの画面で、チャットの時系列と「今日・今週やったこと」に並ぶ。返事の中で残したことを言う必要はない。戻り値: 成功 { ok: true, チャット番号, やったこと, 時刻 }／失敗 { ok: false, code, message }。",
    {
      chat: z.string().max(500).describe(CHAT_DESC),
      text: z.string().max(400).describe("やったことの 1 行（「○○をした」・200 字まで）"),
    },
    async ({ chat, text }) => {
      try {
        const d = checkDone(text);
        if (!d.ok) return asMcpTextResult({ ok: false, code: "invalid_done", message: d.message });
        const { chat: row } = await resolveChat(env, chat);
        const r = await addDone(env, Number(row.no), d.text);
        return asMcpTextResult({ ok: true, チャット番号: Number(row.no), やったこと: r.row.text, 時刻: jstShort(r.row.at) });
      } catch (e) { return fail(e); }
    }
  );
}
