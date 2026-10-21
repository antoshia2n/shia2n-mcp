// @ts-nocheck
/**
 * 案件くんの取り込みの芯（anken リポジトリの src/core/parse.js と同じ中身を写したもの）。
 * 直すときは両方を同じに直す。試験は test/anken-core.test.ts。
 */
const DAY_RE = /^(\d{4})[./年](\d{1,2})[./月](\d{1,2})日?\s*(?:\(.\)|（.）|.曜日)?\s*$/;
const MSG_RE = /^(午前|午後)?(\d{1,2}):(\d{2})(?:\t| +)(.*)$/;
const TITLE_RE = /^\[LINE\]\s*(.+?)(?:とのトーク履歴|のトーク履歴)\s*$/;

const pad = (n) => String(n).padStart(2, "0");

function toTime(ampm, h, m) {
  let hh = Number(h);
  if (ampm === "午後" && hh < 12) hh += 12;
  if (ampm === "午前" && hh === 12) hh = 0;
  return `${pad(hh)}:${m}`;
}

/** 空白区切りの行から、名前らしい語の並びを集める（3 回以上、行の頭に同じ並びで出るもの） */
function guessNames(lines, self = []) {
  const cnt = new Map();
  for (const ln of lines) {
    const m = ln.match(MSG_RE);
    if (!m || m[4].includes("\t")) continue;
    const toks = m[4].split(/ +/);
    for (let i = 1; i <= Math.min(4, toks.length - 1); i++) {
      const k = toks.slice(0, i).join(" ");
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  const names = new Set(self.filter(Boolean));
  for (const [k, n] of cnt) {
    if (n < 3) continue;
    const first = k.split(" ")[0];
    if (n >= 0.6 * (cnt.get(first) || n)) names.add(k);
  }
  return names;
}

function splitWho(rest, names) {
  if (rest.includes("\t")) {
    const [who, ...body] = rest.split("\t");
    if (!body.length) return { who: "", body: who, system: true };
    return { who: who.trim(), body: body.join("\t") };
  }
  const toks = rest.split(/ +/);
  for (let i = Math.min(4, toks.length - 1); i >= 1; i--) {
    const k = toks.slice(0, i).join(" ");
    if (names.has(k)) return { who: k, body: toks.slice(i).join(" ") };
  }
  // 名前が分からないとき：最初の語を名前とみなす（1 語の名前がいちばん多い）
  if (toks.length > 1) return { who: toks[0], body: toks.slice(1).join(" ") };
  return { who: "", body: rest, system: true };
}

/** 囲みの " を外す（LINE は改行を含む発言を " で囲み、中の " を "" にする） */
function unquote(body) {
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"') && body.includes("\n")) {
    return body.slice(1, -1).replace(/""/g, '"');
  }
  return body;
}

export function parseLine(text: any, opts: any = {}): any {
  const { self = [] } = opts;
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const names = guessNames(lines, self);
  let title = "";
  let day = null;
  let open = false; // " で始まり、まだ閉じていない発言
  const out = [];
  const skipped = [];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!out.length && !day) {
      const t = ln.match(TITLE_RE);
      if (t) { title = t[1].trim(); continue; }
      if (/^保存日時/.test(ln) || !ln.trim()) continue;
    }
    // 閉じの " が見つからないまま、タブ区切りの新しい発言が来たら、そこで閉じたとみなす（取りこぼし防止）
    if (open && /^\d{1,2}:\d{2}\t[^\t]+\t/.test(ln)) open = false;
    if (!open) {
      const d = ln.match(DAY_RE);
      if (d) { day = `${d[1]}-${pad(d[2])}-${pad(d[3])}`; continue; }
      const m = ln.match(MSG_RE);
      if (m && day && (m[4].includes("\t") || /\S +\S/.test(m[4]) || !out.length)) {
        const { who, body, system } = splitWho(m[4], names);
        out.push({ day, time: toTime(m[1], m[2], m[3]), who, body, system: !!system });
        open = body.startsWith('"') && !(body.length > 1 && body.endsWith('"') && !body.endsWith('""'));
        continue;
      }
    }
    if (out.length) {
      const last = out[out.length - 1];
      last.body += "\n" + ln;
      if (open && ln.endsWith('"') && !ln.endsWith('""')) open = false;
      continue;
    }
    if (ln.trim()) skipped.push(ln);
  }

  for (const m of out) {
    m.body = unquote(m.body.replace(/\n+$/, ""));
  }
  const days = out.map((m) => m.day);
  return {
    title,
    messages: out,
    skipped,
    names: [...new Set(out.map((m) => m.who).filter(Boolean))],
    from: days.length ? days.reduce((a, b) => (a < b ? a : b)) : null,
    to: days.length ? days.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/* ───────── 伏せ字 ───────── */

const LABEL = String.raw`(?:ID|ＩＤ|ｉｄ|id|ログインID|ユーザー名|ユーザ名|ユーザーID|アカウント|ログイン|メアド|メールアドレス|mail|e-mail|email|パスワード|パス|password|pass|PW|ＰＷ|pw|暗証番号|PIN)`;
const LABEL_LINE = new RegExp(String.raw`^(\s*[・\-*●■▪◆]?\s*[^\n:：=＝]{0,16}?${LABEL}\s*[:：=＝]\s*)(\S.*)$`, "i");
const PASS_WORD = new RegExp(String.raw`(?:パスワード|password|pass|PW|ＰＷ|暗証番号)`, "i");
const MASK = "＊＊＊（伏せた）";

/**
 * 1 行ずつ見て、「ラベル：値」の値を伏せる。
 * 「パスワード」とだけ書いた行のすぐ下が空白の無い短い文字なら、その行も伏せる。
 * 返り値：{ text, count }（伏せた数）
 */
export function maskSecrets(text: any): { text: string; count: number } {
  const lines = String(text ?? "").split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LABEL_LINE);
    if (m && !/https?:\/\//.test(m[2])) {
      lines[i] = m[1] + MASK;
      count++;
      continue;
    }
    const bare = lines[i].trim();
    if (bare && bare.length <= 20 && PASS_WORD.test(bare) && !/[:：=＝]/.test(bare)) {
      const nx = (lines[i + 1] ?? "").trim();
      if (nx && !/\s/.test(nx) && nx.length <= 64 && !/^https?:/.test(nx)) {
        lines[i + 1] = MASK;
        count++;
        i++;
      }
    }
  }
  return { text: lines.join("\n"), count };
}

/* ───────── 重ならない印 ───────── */

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 発言ごとに印を付ける。日付・時刻・発言者・本文が同じ発言が 1 回の取り込みに 2 つあれば、
 * 出てきた順の番号で区別する（「画像」を 3 枚続けて送ったときなど）。
 * 同じ履歴をもう一度入れると、同じ順で同じ印になるので重ならない。
 */
export async function withHashes(msgs: any[]): Promise<any[]> {
  const seen = new Map();
  const out = [];
  for (const m of msgs) {
    const key = `${m.day}|${m.time}|${m.who}|${m.body}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    out.push({ ...m, hash: await sha256(`${key}|${n}`) });
  }
  return out;
}

/* ───────── 議事録 ───────── */

const MIN_DAY_RE = /^\s*[#＃■◆●【\[]*\s*(?:(\d{4})[./年-])?(\d{1,2})[./月](\d{1,2})日?(?![\d:])/;

/**
 * 議事録の文を、日付の見出しごとの塊にする。1 つの塊を 1 件の発言（発言者「議事録」）として持つ。
 * 年の無い日付（10/15）は、直前の年か、無ければ today の年で読む。今日より先になる月日は前の年とみなす。
 * 日付の見出しが 1 つも無いときは、文の全部を today の 1 件にする。
 */
export function parseMinutes(text: any, opts: any = {}): any {
  const { today, who = "議事録" } = opts;
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const ty = Number(String(today).slice(0, 4));
  let year = null;
  const out = [];
  let cur = null;
  for (const ln of lines) {
    const m = ln.length <= 80 ? ln.match(MIN_DAY_RE) : null;
    if (m) {
      let y = m[1] ? Number(m[1]) : (year ?? ty);
      const d = `${y}-${pad(m[2])}-${pad(m[3])}`;
      if (!m[1] && !year && d > today) y -= 1;
      year = y;
      cur = { day: `${y}-${pad(m[2])}-${pad(m[3])}`, time: "", who, body: ln.trim(), system: false };
      out.push(cur);
      continue;
    }
    if (!cur) {
      if (!ln.trim()) continue;
      cur = { day: today, time: "", who, body: "", system: false };
      out.push(cur);
    }
    cur.body += (cur.body ? "\n" : "") + ln;
  }
  for (const m of out) m.body = m.body.replace(/\s+$/, "");
  const kept = out.filter((m) => m.body.trim());
  const days = kept.map((m) => m.day);
  return {
    title: "",
    messages: kept,
    skipped: [],
    names: [who],
    from: days.length ? days.reduce((a, b) => (a < b ? a : b)) : null,
    to: days.length ? days.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/** 自分（Naoki）の名前。LINE の表示名の揺れを全部挙げる。「自分の約束」を拾うときにも使う */
export const SELF_NAMES = ["NAOKI TAKEBAYASHI", "NAOKI", "シアニン", "竹林直樹"];
