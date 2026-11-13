/**
 * note攻略くんの「自分の記事」を note の数字から作る計算（2026-11-10 開発部・作業 72・Naoki「OK」20:55）。
 * 書く道具は src/tools-notekoryaku.ts。ここは計算だけ（試験は test/notekoryaku-core.test.ts）。
 *
 * スワイプ候補の決め：公開日の順に並べ、前後 5 本ずつ（端では片側だけ）の計 10 本のスキの真ん中（中央値）を「近い 10 本」とする。
 *   その記事のスキ ÷ 近い 10 本 が 1.2 倍以上なら候補。真ん中が 0 のときは 1 として割る（0 で割らない）。
 *   候補の印 pick = { r 倍率, base 真ん中, n 比べた本数, at 判定した日, st }。st は new（まだ見ていない）・sent（スワイプくんへ入れた）・skip（見送った）。
 *   判定し直すのは judge の範囲の記事だけ。範囲の外の印はそのまま残す。Naoki が決めた sent・skip は倍率だけ新しくし、st は残す。
 */

export type NoteIn = { key: string; title: string; published_at: string; price?: number; membership?: boolean; views?: number | null; likes?: number | null; comments?: number | null };
export type Snap = { v: number | null; l: number | null; c: number | null };
export type Pick = { r: number; base: number; n: number; at: string; st: "new" | "sent" | "skip" };
export type Old = { note_key: string; snaps?: Record<string, Snap> | null; pick?: Pick | null; sort?: number | null };

export const RATIO = 1.2;
export const SPAN = 5;
export const NOTE_URL = (key: string) => `https://note.com/shia2n/n/${key}`;

const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString();
export const jstDay = (iso: string) => jst(iso).slice(0, 10);
export const jstMonth = (iso: string) => jst(iso).slice(0, 7);
export const prevMonthOf = (day: string) => { const [y, m] = day.slice(0, 7).split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };

/** 種類：値段が付いていれば有料、メンシプにつながっていればメンシプ、ほかは無料 */
export const kindOf = (a: NoteIn) => ((+(a.price ?? 0) > 0) ? "paid" : a.membership ? "member" : "free");

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 記事ごとの倍率（公開日の順・前後 SPAN 本ずつ） */
export function ratios(arts: NoteIn[]): Map<string, { r: number; base: number; n: number }> {
  const a = [...arts].filter(x => num(x.likes) != null).sort((p, q) => p.published_at.localeCompare(q.published_at));
  const out = new Map<string, { r: number; base: number; n: number }>();
  a.forEach((x, i) => {
    const nb = [...a.slice(Math.max(0, i - SPAN), i), ...a.slice(i + 1, i + 1 + SPAN)];
    if (!nb.length) return;
    const base = median(nb.map(y => num(y.likes) as number));
    out.set(x.key, { r: Math.round(((num(x.likes) as number) / Math.max(base, 1)) * 100) / 100, base, n: nb.length });
  });
  return out;
}

/** 範囲：all（全部）か YYYY-MM（その月に公開した記事） */
export const inJudge = (judge: string, a: NoteIn) => judge === "all" || jstMonth(a.published_at) === judge;

export function nextPick(old: Pick | null | undefined, rr: { r: number; base: number; n: number } | undefined, judged: boolean, day: string): Pick | null {
  if (!judged) return old ?? null;
  const kept = old && (old.st === "sent" || old.st === "skip") ? old.st : null;
  if (!rr) return old ?? null;
  if (rr.r >= RATIO) return { r: rr.r, base: rr.base, n: rr.n, at: day, st: kept ?? "new" };
  return kept ? { r: rr.r, base: rr.base, n: rr.n, at: day, st: kept } : null; // 入れた・見送ったものは、倍率が下がっても印を消さない
}

/** 表に送る行（全部の行が同じ欄を持つ。PostgREST のまとめ送りの決まり） */
export function buildRows(owner: string, arts: NoteIn[], olds: Old[], day: string, judge: string) {
  const byKey = new Map(olds.map(o => [o.note_key, o]));
  const rr = ratios(arts);
  const sorted = [...arts].sort((p, q) => q.published_at.localeCompare(p.published_at));
  const rows = sorted.map((a, i) => {
    const o = byKey.get(a.key);
    const snap: Snap = { v: num(a.views), l: num(a.likes), c: num(a.comments) };
    return {
      user_id: owner, note_key: a.key, month: jstMonth(a.published_at), published_on: jstDay(a.published_at),
      title: String(a.title || "").slice(0, 300), url: NOTE_URL(a.key), kind: kindOf(a),
      views: snap.v, likes: snap.l, comments: snap.c, sort: o?.sort ?? (1000 + i),
      snaps: { ...(o?.snaps && typeof o.snaps === "object" ? o.snaps : {}), [day]: snap },
      pick: nextPick(o?.pick, rr.get(a.key), inJudge(judge, a), day),
      updated_at: new Date().toISOString(),
    };
  });
  return { rows, added: arts.filter(a => !byKey.has(a.key)).length };
}

/* ── ここから見る相手（2026-11-10 作業 73）──
 * note攻略くん：見る相手（自分以外）の月の数字とスワイプ候補の計算（2026-11-10 開発部・作業 73・Naoki「OK」21:41）。
 * 取りに行く・書くのは src/notekoryaku-others.ts。試験は test/notekoryaku-others-core.test.ts。
 *
 * 数字：その月に公開した記事を、種類（値段あり＝有料・メンシプにつながる＝メンシプ・ほか無料）ごとに [本数, スキの合計] で数える。
 *   スキは取った時点の合計（note は月ごとのスキを出さない）。全体ビューは他人には見えないので扱わない。
 * 候補：自分の記事と同じ決め（公開日の近い前後 10 本のスキの真ん中の 1.2 倍以上）。比べる相手は同じアカウントの記事だけ。
 * 分析の文・評価・集客ルート・メンシプ人数には触らない（分析は Naoki が書く。メンシプ人数は公開されていない）。
 */

export type Ski = { f: [number, number]; p: [number, number]; m: [number, number] };
export const KIND_KEY: Record<string, keyof Ski> = { free: "f", paid: "p", member: "m" };
/** 見る相手の種類（2026-11-10 Naoki「直して」22:22）：メンシプにつながっていればメンシプを先に見る（単品でも買えるメンシプ記事をメンシプに数える。Naoki の手の数え方に合わせた）。自分の記事は kindOf のまま */
export const kindOfOther = (a: NoteIn) => (a.membership ? "member" : (+(a.price ?? 0) > 0) ? "paid" : "free");

export function skiOf(arts: NoteIn[], month: string): Ski {
  const s: Ski = { f: [0, 0], p: [0, 0], m: [0, 0] };
  for (const a of arts) {
    if (jstMonth(a.published_at) !== month) continue;
    const k = KIND_KEY[kindOfOther(a)];
    s[k][0] += 1; s[k][1] += Math.max(0, Math.round(+(a.likes ?? 0) || 0));
  }
  return s;
}
export const skiEmpty = (v: unknown) => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return ["f", "p", "m"].every(k => { const x = o[k]; return !Array.isArray(x) || (!(+x[0]) && !(+x[1])); });
};

export type PickRow = { account: string; note_key: string; title: string; url: string; published_on: string; month: string; kind: string; likes: number; comments: number | null; r: number; base: number; n: number; at: string };

export function picksOf(account: string, urlname: string, arts: NoteIn[], months: string[], day: string): PickRow[] {
  const rr = ratios(arts);
  const out: PickRow[] = [];
  for (const a of arts) {
    const m = jstMonth(a.published_at);
    if (!months.includes(m)) continue;
    const x = rr.get(a.key);
    if (!x || x.r < RATIO) continue;
    out.push({ account, note_key: a.key, title: String(a.title || "").slice(0, 300), url: `https://note.com/${urlname}/n/${a.key}`, published_on: jstDay(a.published_at), month: m,
      kind: kindOfOther(a), likes: Math.round(+(a.likes ?? 0)), comments: a.comments ?? null, r: x.r, base: x.base, n: x.n, at: day });
  }
  return out.sort((p, q) => q.r - p.r);
}

/** いくつのページまで読めば足りるか：最古の対象月の頭より古い記事が 6 本たまり、ページの最後もその頭より古いなら止める */
export function enoughOlder(arts: NoteIn[], lastOnPage: string | null, firstMonth: string): boolean {
  const start = `${firstMonth}-01`;
  const older = arts.filter(a => jstDay(a.published_at) < start).length;
  return older >= 6 && !!lastOnPage && jstDay(lastOnPage) < start;
}

/** 対象の月：初回の遡り（2026-08〜10）と、毎月 2 日からは前の月。今月とまだ来ない月は入れない */
export const BACKFILL = ["2026-08", "2026-09", "2026-10"];
export function targetMonths(today: string): string[] {
  const [y, m, d] = today.split("-").map(Number);
  const cur = `${y}-${String(m).padStart(2, "0")}`;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const set = new Set(BACKFILL.filter(x => x < cur));
  if (d >= 2) set.add(prev);
  return [...set].filter(x => x < cur).sort();
}

/** 次に回す相手：まだ済んでいない月がある相手を、並び順で 1 人 */
export function nextAccount(accounts: string[], done: Record<string, string[]>, months: string[]): { account: string; months: string[] } | null {
  for (const a of accounts) {
    const left = months.filter(m => !(done[m] || []).includes(a));
    if (left.length) return { account: a, months: left };
  }
  return null;
}

/* ── note攻略くんの立ち回り（2026-11-12 攻略の8段 便5・notekoryaku__get_moves）──
 * X攻略くんの movesOf（xbunseki-core.ts）と同じ考えを月で回す。読むだけ・計算は note攻略くんの画面と同じ式。
 *   立ち回り＝na_items の kind st（使い始めた月 plan_month が見る月以前・しまっていない）。列は 集客ルート（route）／記事（pstyle・pcont）／売り方と運用（ostyle・ocont）
 *   状態＝state（''＝今月やる・wait＝控え・stop＝停止）
 *   戦術表＝na_settings.ladder.shape[月]["週:種類"] = { t, s（立ち回りの id）}。種類 f 無料・m メンシプ・p 有料・r 集客。週はその月の中の月曜から始まる週
 *   予定と実績＝結んだマス（集客は数えない）のうち、その週にコンテンツくんで同じ種類の記事（note・membership・paid）が予約か公開されたか
 *   評価＝na_settings.ladder.ev[月][立ち回りの id] = 5〜1 */
type R = Record<string, any>;
export const NK_COL: Record<string, string> = { route: "集客", pstyle: "記事", pcont: "記事", ostyle: "売り方と運用", ocont: "売り方と運用", goal: "その他" };
export const NK_EV: Record<number, string> = { 5: "最高", 4: "良い", 3: "普通", 2: "悪い", 1: "最悪" };
const KIND_NAME: Record<string, string> = { f: "無料", m: "メンシプ", p: "有料", r: "集客" };
const PT_KIND: Record<string, string> = { note: "f", membership: "m", paid: "p" };
export function monthMondays(month: string): string[] {
  const [y, m] = month.split("-").map(Number), out: string[] = [];
  for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === 1) out.push(`${month}-${String(d).padStart(2, "0")}`); }
  return out;
}
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TY_KIND: Record<string, string> = { note: "f", membership: "m", paid: "p" };
const TY_NAME: Record<string, string> = { note: "note（無料）", membership: "メンシプ", paid: "有料", x_post: "Xポスト", x_quote: "X引用", x_article: "X記事", other: "その他" };
export function nkMovesOf(items: R[], month: string, ladder: R | null, posts: R[], today: string): R[] {
  const W = monthMondays(month), shape: R = ladder?.shape?.[month] || {}, ev: R = ladder?.ev?.[prevMonthOf(month + "-01")] || {};
  const P = posts.map(p => ({ k: PT_KIND[p.post_type] || "", day: String(p.datetime || "").slice(0, 10), t: p.title || "", st: p.status })).filter(p => p.k && (p.st === "reserved" || p.st === "published"));
  return items.filter(i => i.kind === "st" && !i.archived && NK_COL[i.layer] && String(i.plan_month || "") <= month).map(i => {
    // 根拠（2026-11-13 便2）：ストックの仮説（hy）とノウハウ（kn）。評価 C 根拠が薄い・B 手応え・A 自分で証明・S 証明＋効果大
    const base = (i.links || []).map((id: string) => items.find(x => x.id === id && (x.kind === "hy" || x.kind === "kn"))).filter(Boolean);
    const hy = base.filter((x: R) => x.kind === "hy").map((x: R) => x.body);
    const why = base.map((x: R) => ({ 種類: x.kind === "kn" ? "ノウハウ" : "仮説", 評価: x.grade || "なし", 文: x.body || "" }));
    const maps = (i.src || []).filter((s: R) => s && s.map && s.map.id).map((s: R) => ({ 名前: s.map.t || "", URL: `https://mindmap.shia2n.jp/m/${s.map.id}` }));
    const refs = (i.src || []).filter((s: R) => s && s.ref).map((s: R) => ({ 題: s.ref.title || "", 投稿者: s.ref.author || "", URL: s.ref.url || "" }));
    // 戦術表のマス → ネタのカード（2026-11-13 便1）。新しい形は { s, items: [{ t, ty, lb, p }] }。前の { t, s, k, p } と「週:f」の形も読む
    const cards: R[] = [];
    Object.entries(shape).forEach(([key, c]: [string, any]) => { if (!c || typeof c !== "object") return; const [n, r] = key.split(":"), old = /^[fmpr]$/.test(r);
      const sid = old ? c.s : (Array.isArray(c.items) ? c.s : (c.s || r)); if (sid !== i.id) return;
      const list = Array.isArray(c.items) ? c.items : String(c.t || "").trim() ? [{ t: c.t, ty: ({ f: "note", m: "membership", p: "paid" } as R)[old ? r : c.k] || "", lb: [], p: c.p }] : [];
      list.forEach((x: R) => { if (String(x.t || "").trim()) cards.push({ n: +n, x }); }); });
    const cells: R[] = cards.sort((a, b) => a.n - b.n).map(({ n, x }) => {
      const k = TY_KIND[x.ty] || "", mon = W[n - 1] || "", sun = mon ? addDays(mon, 6) : "";
      const outs = !k || !mon ? [] : P.filter(p => p.k === k && p.day >= mon && p.day <= sun);
      const counts = !!k || !!x.p;
      return { 週: `${n}週${mon ? `（${+mon.slice(5, 7)}/${+mon.slice(8)}〜）` : ""}`, ...(x.ty ? { 種別: TY_NAME[x.ty] || x.ty } : {}), 書いた文: String(x.t), ...(Array.isArray(x.lb) && x.lb.length ? { ラベル: x.lb } : {}),
        ...(x.p ? { コンテンツくん: `https://content-os.shia2n.jp/?post=${x.p}` } : {}), 始まった: !!mon && mon <= today,
        ...(!counts ? { 数え方: "種別が記事でなく、コンテンツくんへも送っていないので数えない" } : k ? { 出した記事: outs.map(p => ({ 日: p.day, 題: p.t, 状態: p.st === "published" ? "公開済み" : "予約" })) } : { 数え方: "コンテンツくんへ送った記事の状態で数える（画面で確かめる）" }) };
    });
    const cnt = cells.filter(c => c.出した記事), due = cnt.filter(c => c.始まった).length, done = cnt.filter(c => c.始まった && (c.出した記事 || []).length).length;
    return { id: i.id, 立ち回り: i.body || "", 列: NK_COL[i.layer], ...(i.layer === "route" && i.memo ? { ルート: i.memo } : {}), 状態: i.state === "wait" ? "控え" : i.state === "stop" ? "やめた" : "今月やる",
      ...(hy.length ? { 仮説: hy } : {}), ...(why.length ? { 根拠: why } : {}), ...(String(i.note || "").trim() ? { 中身: String(i.note) } : {}), ...(maps.length ? { 思考整理くん: maps } : {}), お手本: refs, ...(ev[i.id] ? { 先月の評価: NK_EV[ev[i.id]] } : {}), 戦術表のマス: cells, ...(cnt.length ? { 予定と実績: `${done} / ${due}（今日までに始まった週のマス・全 ${cnt.length}）` } : {}) };
  });
}
export function nkGoalsOf(ladder: R | null): R[] {
  const ST: Record<string, string> = { todo: "これから", try: "試し中", ok: "できた", ng: "外した" };
  return (ladder?.goals || []).map((g: R) => ({ 目標: g.t || "", レベル: `Lv${g.from}〜${(+g.from || 0) + 10}`, ...(g.when ? { いつまで: g.when } : {}), ...(g.metric ? { 測る数: g.metric } : {}),
    マイルストーン: (g.ms || []).map((m: R, i: number) => (m && String(m.t || "").trim() ? { Lv: (+g.from || 0) + i + 1, 中身: m.t, 種類: m.type === "res" ? "成果" : "行動", 状態: ST[m.st] || "これから" } : null)).filter(Boolean) }));
}


/* ── 仮説とノウハウのストック（2026-11-13 便3）── */
export const STOCK_KIND: Record<string, string> = { 仮説: "hy", ノウハウ: "kn" };
const GR_ORD: Record<string, number> = { S: 4, A: 3, B: 2, C: 1, "": 0 };
const MM_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** ストックの一覧（読むだけ）。評価の高い順・新しい順 */
export function nkStockOf(items: R[], accounts: R[], months: R[], kind?: string, folder?: string): R[] {
  const name = (h: string) => accounts.find(a => a.handle === h)?.name || h, mk = (id: string) => months.find(m => m.id === id)?.month || "";
  return items.filter(i => (i.kind === "hy" || i.kind === "kn") && !i.archived && (!kind || i.kind === kind) && (folder == null || String(i.folder || "") === folder))
    .sort((a, b) => (GR_ORD[b.grade || ""] - GR_ORD[a.grade || ""]) || String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .map(i => {
      const src = (i.src || []) as R[], gr = (Array.isArray(i.grades) ? i.grades : []) as R[];
      let down = ""; for (let n = 1; n < gr.length; n++) if (GR_ORD[gr[n].g] < GR_ORD[gr[n - 1].g]) down = `${gr[n].at} に ${gr[n - 1].g}→${gr[n].g}`;
      const used = items.filter(x => x.kind === "st" && !x.archived && (x.links || []).includes(i.id)).map(x => x.body);
      return { id: i.id, 種類: i.kind === "kn" ? "ノウハウ" : "仮説", 文: i.body || "", 評価: i.grade || "なし", フォルダ: i.folder || "未分類", 登録: String(i.created_at || "").slice(0, 10),
        ...(gr.length ? { 評価の変化: gr.map(x => `${x.g} ${x.at}`).join(" → ") } : {}), ...(down ? { ここまで通用: down } : {}),
        ...(src.some(x => x.account) ? { 出どころ: [...new Set(src.filter(x => x.account).map(x => `${name(x.account)}${mk(x.month_id) ? `（${mk(x.month_id)} の分析）` : ""}`))] } : {}),
        ...(src.some(x => x.map || x.link) ? { リンク: src.filter(x => x.map || x.link).map(x => x.map ? { 名前: x.map.t || "思考整理くんのマップ", URL: `https://mindmap.shia2n.jp/m/${x.map.id}` } : { 名前: x.link.t || x.link.url, URL: x.link.url }) } : {}),
        ...(String(i.note || "").trim() ? { メモ: i.note } : {}), ...(used.length ? { 使っている立ち回り: used } : {}) };
    });
}
/** ストックへ足す行（評価 C・評価の変化に今日）。同じ種類で同じ文がもうあれば null（足さない） */
export function nkStockRow(x: R, owner: string, today: string, items: R[], mapTitle: Record<string, string>): R | null {
  const kind = STOCK_KIND[x.kind] || ""; const body = String(x.text || "").trim().slice(0, 500);
  if (!kind || !body) return null;
  if (items.some(i => i.kind === kind && !i.archived && String(i.body || "").trim() === body)) return null;
  const src: R[] = [];
  for (const u of [x.map_url, ...(Array.isArray(x.links) ? x.links.map((l: R) => l.url) : [])].filter(Boolean)) {
    const v = String(u), mid = /mindmap\.shia2n\.jp/.test(v) ? (v.match(MM_RE) || [""])[0].toLowerCase() : "";
    if (mid) { if (!src.some(s => s.map?.id === mid)) src.push({ map: { id: mid, t: mapTitle[mid] || "" } }); }
    else if (/^https?:\/\//.test(v) && !src.some(s => s.link?.url === v)) src.push({ link: { url: v, t: String((x.links || []).find((l: R) => l.url === v)?.title || "").slice(0, 80) || v.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60) } });
  }
  return { user_id: owner, layer: "goal", kind, body, src, links: [], grade: "C", grades: [{ g: "C", at: today }], folder: String(x.folder || "").trim().slice(0, 30), note: String(x.note || "").slice(0, 4000), memo: "", archived: false };
}
