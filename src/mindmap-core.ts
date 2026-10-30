/**
 * 思考整理くん（mindmap.shia2n.jp）のマップを読み書きするときの、表に触らない部分。
 * 2026-10-18 開発部（AI 連携の段階 A）。表に触るのは tools-mindmap.ts。
 *
 * マップの形（mm_maps の root と nodes。画面 antoshia2n/mindmap の src/engine.js と同じ）
 *   nodes[id] = { id, text, children[], parent, collapsed, color, side,
 *                 memo?, link?, img?, ai?（AI への指示）, check?（todo|done）, tm?（TaskMaster の印）,
 *                 by?（"ai" = Claude が足した枝。画面で「AI」の印が付き、残す／捨てるを選ぶ） }
 *
 * 決まり
 *   ・Claude は枝を足すだけ。Naoki の枝の文字を書き換えたり消したりしない
 *   ・足した枝には必ず by: "ai" を付ける（Naoki の考えと混ざらないため）
 *   ・印の形（id・色）は画面と同じ決まりで作る（画面が読み込むときに外さないため）
 */

export type MNode = {
  id: string; text: string; children: string[]; parent: string | null;
  collapsed?: boolean; color?: string | null; side?: string | null; hue?: string;
  memo?: string; link?: string; img?: unknown; ai?: string; check?: "todo" | "done"; tm?: string; by?: "ai";
};
export type MNodes = Record<string, MNode>;

export const PAL = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
export const ID_RE = /^[\w-]{1,64}$/;
const BULLET = /^(・\s*|[-*•]\s+|\d+[.)]\s+)/;
const CHECK = /^(?:\[( |x|X)?\]|［(\s?)］|「」|【】)\s*/;

export const newId = () => "n" + Math.random().toString(36).slice(2, 10);

/** 画面の api.js と同じ：名前・枝の数・探すための文字 */
export const titleOf = (root: string, nodes: MNodes) => (nodes?.[root]?.text ?? "").trim();
export const countNodes = (nodes: MNodes) => Math.max(0, Object.keys(nodes || {}).length - 1);
export const bodyOf = (nodes: MNodes) =>
  Object.values(nodes || {}).map((n) => [n.text, n.link && n.link !== n.text ? n.link : null, n.memo].filter(Boolean).join(" ")).join("\n").slice(0, 20000);

/** 根から id までの道すじ（「中心 > 枝 > 枝」） */
export function pathOf(nodes: MNodes, id: string): string {
  const out: string[] = []; let cur: string | null = id; let guard = 0;
  while (cur && nodes[cur] && guard++ < 200) { out.unshift((nodes[cur].text || "（名前なし）").trim()); cur = nodes[cur].parent; }
  return out.join(" > ");
}

/**
 * 1 枚を箇条書きの文字にする。各行の末尾に {id} を付け、足す・済みにするときの宛先に使う。
 * チェックは [ ] / [x]、Claude が足した枝は (AI)、メモ・AI への指示は次の行に字下げして出す。
 */
export function toOutline(root: string, nodes: MNodes, from?: string): string {
  const start = from && nodes[from] ? from : root;
  const lines: string[] = [];
  const head = nodes[start];
  if (!head) return "";
  lines.push(`# ${(head.text || "（名前なし）").trim()} {${start}}`);
  if (head.memo) lines.push(`  メモ: ${oneLine(head.memo)}`);
  if (head.ai) lines.push(`  AI への指示: ${oneLine(head.ai)}`);
  const walk = (id: string, d: number) => {
    for (const c of nodes[id]?.children ?? []) {
      const n = nodes[c]; if (!n) continue;
      const pad = "  ".repeat(d);
      const ck = n.check === "done" ? "[x] " : n.check === "todo" ? "[ ] " : "";
      const tags = [n.by === "ai" ? "(AI)" : "", n.tm ? "(TaskMaster に入れた)" : "", n.link ? `(リンク ${n.link})` : "", n.img ? "(画像)" : ""].filter(Boolean).join(" ");
      lines.push(`${pad}- ${ck}${(n.text || "（名前なし）").trim()}${tags ? " " + tags : ""} {${c}}`);
      if (n.memo) lines.push(`${pad}  メモ: ${oneLine(n.memo)}`);
      if (n.ai) lines.push(`${pad}  AI への指示: ${oneLine(n.ai)}`);
      walk(c, d + 1);
    }
  };
  walk(start, 0);
  return lines.join("\n");
}
const oneLine = (s: string) => String(s).replace(/\s*\n\s*/g, " / ").slice(0, 2000);

/** AI への指示が残っている枝（指示の文字が空でないもの） */
export function findRequests(root: string, nodes: MNodes) {
  return Object.values(nodes || {})
    .filter((n) => typeof n.ai === "string" && n.ai.trim())
    .map((n) => ({ node_id: n.id, 枝: (n.text || "（名前なし）").trim(), 道すじ: pathOf(nodes, n.id), 指示: n.ai!.trim(), 子の枝の数: (n.children || []).length, 中心か: n.id === root }));
}

/** 箇条書きの文字（字下げ 2 つか全角の空白 1 つで 1 段・「・」「-」・[ ] でチェック）を木の並びにする */
export type Item = { text: string; check?: "todo" | "done"; memo?: string; link?: string; children: Item[] };

/**
 * 行の末尾からリンクを取り出す（2026-10-30 シアニン担当の依頼）。
 * 「… (リンク https://…)」（mindmap__get_map が返す形）と、末尾の素の https://… の両方を link にして、文字からは外す。
 * get_map の行をそのまま書き戻せるよう、末尾の (AI)・(TaskMaster に入れた)・(画像)・{id} の印も外す（枝の印は道具が付け直す）。
 * 行が URL だけのときは、画面と同じく文字も URL のまま残す。
 */
const TAIL_MARKS = /\s*(?:\(AI\)|\(TaskMaster に入れた\)|\(画像\)|\{[A-Za-z0-9_-]{1,40}\})$/;
const TAIL_LINK = /\s*[(（]リンク\s+(https?:\/\/[^\s)）]+)\s*[)）]$/i;
const TAIL_URL = /(?:^|\s+)(https?:\/\/\S+)$/i;
const okUrl = (u: string) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && u.length <= 2000 ? x.href : null; } catch { return null; } };
export function splitLink(line: string): { text: string; link?: string } {
  let t = line.trim(), link: string | undefined;
  for (let i = 0; i < 8; i++) {
    const before = t;
    t = t.replace(TAIL_MARKS, "").trim();
    if (!link) {
      const m = t.match(TAIL_LINK) || t.match(TAIL_URL);
      const u = m && okUrl(m[1]);
      if (u) { link = u; const rest = t.slice(0, t.length - m![0].length).trim(); t = rest || m![1]; }
    }
    if (t === before) break;
  }
  return link ? { text: t, link } : { text: t };
}
export function parseBullets(text: string): Item[] {
  const top: Item[] = []; const stack: { ind: number; item: Item }[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const ind = raw.match(/^[\s　]*/)![0].replace(/\t/g, "  ").replace(/　/g, "  ").length;
    let t = raw.trim().replace(BULLET, "");
    let check: Item["check"];
    const ck = t.match(CHECK);
    if (ck) { check = /x/i.test(ck[1] || "") ? "done" : "todo"; t = t.slice(ck[0].length); }
    const sp = splitLink(t); t = sp.text.trim(); if (!t) continue;
    const item: Item = { text: t.slice(0, 500), children: [] }; if (check) item.check = check; if (sp.link) item.link = sp.link;
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    (stack.length ? stack[stack.length - 1].item.children : top).push(item);
    stack.push({ ind, item });
  }
  return top;
}

/**
 * parent の子として枝を足す（足した枝すべてに by: "ai"）。nodes は書き換える。
 * 中心の直下に足すときは、画面と同じく色を順に回し、左右を交互に置く。
 * 戻り値は足した枝の id（並び順）。
 */
export function addItems(root: string, nodes: MNodes, parent: string, items: Item[], memoForFirst?: string): string[] {
  if (!nodes[parent]) throw new Error("足し先の枝が見つかりません（get_map の {id} を使ってください）");
  const made: string[] = [];
  const put = (pid: string, list: Item[]) => {
    for (const it of list) {
      let id = newId(); while (nodes[id]) id = newId();
      const top = pid === root;
      const k = top ? nodes[root].children.length : 0;
      const n: MNode = { id, text: it.text, children: [], parent: pid, collapsed: false, color: top ? PAL[k % PAL.length] : null, side: top ? (k % 2 ? "l" : "r") : null, by: "ai" };
      if (it.check) n.check = it.check;
      if (it.memo) n.memo = it.memo.slice(0, 5000);
      if (it.link) n.link = it.link;
      nodes[id] = n; nodes[pid].children.push(id); made.push(id);
      put(id, it.children);
    }
  };
  if (memoForFirst && items[0]) items[0].memo = memoForFirst;
  put(parent, items);
  if (nodes[parent].collapsed) nodes[parent].collapsed = false; // 足した枝が見えるように開く
  return made;
}

/**
 * 新しいマップの木（2026-10-24 mindmap__create_map）。
 * 中心は画面の newMap の「白紙から」と同じ形（色・左右なし・開いた状態）で、文字だけ名前にする。
 * items があれば中心の子として addItems で足す（mindmap__add_branches と同じく、すべて by: "ai"）。
 */
export function newMapTree(name: string, items: Item[] = []): { root: string; nodes: MNodes; made: string[] } {
  const root = newId();
  const nodes: MNodes = { [root]: { id: root, text: name, children: [], parent: null, collapsed: false, color: null, side: null } };
  const made = items.length ? addItems(root, nodes, root, items) : [];
  return { root, nodes, made };
}

/** マップの名前をそろえる（改行は空白 1 つに・前後の空白を落とす） */
export const cleanName = (s: string) => String(s ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
/** 同じ名前か（前後の空白と、続いた空白の数の違いは同じとみなす） */
export const sameName = (a: string, b: string) => cleanName(a).replace(/\s+/g, " ") === cleanName(b).replace(/\s+/g, " ");

/** チェックを済み（または未完了）にする。チェックでない枝はチェックにしてから付ける */
export function markChecks(nodes: MNodes, ids: string[], done: boolean): { 変えた: string[]; 見つからない: string[] } {
  const changed: string[] = [], missing: string[] = [];
  for (const id of ids) {
    const n = nodes[id]; if (!n) { missing.push(id); continue; }
    const v = done ? "done" : "todo";
    if (n.check !== v) { n.check = v; changed.push(id); }
  }
  return { 変えた: changed, 見つからない: missing };
}
