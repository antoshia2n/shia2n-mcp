// @ts-nocheck
/**
 * 案件くんの取り込みの芯（anken リポジトリの src/core/parse.js と同じ中身を写したもの・2026-10-22 に写し直し：伏せ字の抜けと " の取りこぼし）。
 * 直すときは両方を同じに直す。試験は test/anken-core.test.ts。
 */
/**
 * 取り込みの芯（画面とサーバーの両方で使う。外の部品に頼らない）。
 *
 *   parseLine(text, { self })  … LINE の「トーク履歴を保存」の .txt か、貼り付けた文を発言の並びにする
 *   maskSecrets(text)          … ID・パスワードらしき値を伏せる（保存する前に必ず通す）
 *   withHashes(msgs, salt)     … 同じ発言を何度入れても 1 回だけになる印を付ける
 *
 * LINE の形（2026-10 時点の書き出し）：
 *   [LINE] ○○とのトーク履歴            ← 先頭。チャットの名前の手がかり
 *   保存日時：2026/10/21 19:00
 *   2026.10.20 火曜日                   ← 日付の行（古い形は 2026/10/20(火)）
 *   10:12<TAB>名前<TAB>本文             ← 発言。タブで区切られる。貼り付けだと空白のことがある
 *   "1 行目                              ← 改行を含む発言は本文が " で囲まれる
 *   2 行目"
 *   10:13<TAB>名前がメッセージの送信を取り消しました  ← 発言者の無い知らせ
 *
 * 名前に空白が入る人がいる（NAOKI TAKEBAYASHI など）。タブ区切りなら迷わない。
 * 空白区切りのときは、行の頭によく出る語の並びを名前とみなす（下の guessNames）。
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

/** LINE の知らせ（発言ではない行）。空白区切りの書き出しでは「名前がメッセージの送信を取り消しました」のように 1 語で来る */
const SYS_TAIL = /(メッセージの送信を取り消しました|グループに参加しました|グループに追加しました|グループを退会しました|グループから削除しました|を退会させました|招待しました|アナウンスしました(<\/u>)?|グループ名を.*に変更しました|新しいノートを作成しました|ノートに投稿しました)。?$/;
const isSystem = (who, body) => SYS_TAIL.test(body) && (!who || body.startsWith(who) || /^新しいノート/.test(body));

function splitWho(rest, names) {
  // 本文にタブが混じった行（表を貼った発言など）：最初の欄が知っている名前でなく、頭が知っている名前なら、空白で分ける
  const field0 = rest.split("\t")[0];
  const known = [...names].filter((n) => field0.startsWith(n + " ")).sort((a, b) => b.length - a.length)[0];
  if (rest.includes("\t") && known && !names.has(field0.trim())) {
    return { who: known, body: rest.slice(known.length + 1) };
  }
  if (rest.includes("\t")) {
    const [who, ...body] = rest.split("\t");
    if (!body.length) return { who: "", body: who, system: true };
    return { who: who.trim(), body: body.join("\t") };
  }
  if (names.has(rest.trim())) return { who: rest.trim(), body: "" };
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
    // 空白区切りの書き出しでも、日付の行のすぐ下に発言の行が来たら閉じたとみなす（2026-10-22 おかぜりの履歴で見つかった取りこぼし）
    if (open && DAY_RE.test(ln) && MSG_RE.test(lines[i + 1] ?? "")) open = false;
    if (!open) {
      const d = ln.match(DAY_RE);
      if (d) { day = `${d[1]}-${pad(d[2])}-${pad(d[3])}`; continue; }
      const m = ln.match(MSG_RE);
      const time = m ? toTime(m[1], m[2], m[3]) : null;
      const last = out[out.length - 1];
      // 同じ日に時刻が戻る行（本文の中の「0:00 - オープニング」のような目次）は、前の発言の続き
      const goesBack = m && last && last.day === day && time < last.time;
      if (m && day && !goesBack && !/\S +[^ ]/.test(m[4]) && !m[4].includes("\t") && SYS_TAIL.test(m[4])) {
        out.push({ day, time, who: "", body: m[4], system: true });
        continue;
      }
      // 名前だけの行（本文が次の行から始まる発言。リンクを改行して貼ったときなど）も 1 件の発言
      const nameOnly = m && names.has(m[4].trim());
      if (m && day && !goesBack && (m[4].includes("\t") || /\S +[^ ]/.test(m[4]) || nameOnly || !out.length)) {
        const { who, body, system } = splitWho(m[4], names);
        out.push({ day, time, who, body, system: !!system || isSystem(who, body) });
        // " で始まっても、同じ行の中で閉じている（「"せどり"のワードは…」）なら複数行の発言ではない
        open = body.startsWith('"') && body.replace(/""/g, "").split('"').length % 2 === 0;
        continue;
      }
    }
    if (out.length) {
      const last = out[out.length - 1];
      // 知らせの行には続きを付けない（続きに見える行は、その前の本当の発言のもの）
      const host = last.system ? [...out].reverse().find((x) => !x.system) || last : last;
      host.body += (host.body ? "\n" : "") + ln;
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
/** API の鍵らしい文字列（Stripe・OpenAI・GitHub・Google・Slack・AWS）。ラベルが無くても伏せる */
const KEY_RE = /(?<![A-Za-z0-9_])(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9_])/g;
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
const PHONE_RE = /(?<![\d-])(?:0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8}|\+81[- ]?\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4})(?![\d-])/g;

/** ラベルだけの行（「ID」「PASS」など。区切りの記号なし） */
const LABEL_ONLY = new RegExp(String.raw`^[・\-*●■▪◆\s]*${LABEL}[\s\\]*$`, "i");
/** 「pass xxxx」のように空白で区切った 1 語の値（2026-10-22 おかぜりの議事録で見つかった形） */
const LABEL_SPACE = new RegExp(String.raw`^(\s*[・\-*●■▪◆]?\s*(?:パスワード|パス|password|pass|PW|ＰＷ|暗証番号|ログインID|ユーザーID|ID|ＩＤ|メールアドレス|メアド|メール|mail|email)\s+)([\x21-\x7E]{3,64})\s*$`, "i");
/** 値らしい 1 語（空白なし・英数と記号だけ・リンクでない） */
const isToken = (s) => !!s && s.length <= 64 && /^[\x21-\x7E]+$/.test(s) && !/^https?:/i.test(s);

/**
 * 1 行ずつ見て、「ラベル：値」の値を伏せる。
 * 「pass xxxx」のように空白で区切った 1 語の値も伏せる。
 * 「ID」「パスワード」とだけ書いた行は、その下（空行は 2 行まで飛ばす）の値の行を伏せる。
 * ラベルの無いメールアドレスと電話番号も伏せる（ミーティング ID・リンクの中の @ は伏せない）。
 * 返り値：{ text, count }（伏せた数）
 */
export function maskSecrets(text: any): { text: string; count: number } {
  const lines = String(text ?? "").split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LABEL_LINE);
    if (m && !/https?:\/\//.test(m[2]) && !/(ミーティング|meeting)\s*ID/i.test(m[1])) {
      lines[i] = m[1] + MASK;
      count++;
      continue;
    }
    const sp = lines[i].match(LABEL_SPACE);
    if (sp && !/(ミーティング|meeting)/i.test(sp[1])) {
      lines[i] = sp[1] + MASK;
      count++;
      continue;
    }
    // ラベルの無いメールアドレス・電話番号も伏せる（申込者の連絡先が貼られることがある）
    const before = lines[i];
    lines[i] = lines[i].replace(EMAIL_RE, MASK).replace(PHONE_RE, MASK).replace(KEY_RE, MASK);
    if (lines[i] !== before) count++;
    const bare = lines[i].trim();
    const passOnly = bare && bare.length <= 20 && PASS_WORD.test(bare) && !/[:：=＝]/.test(bare);
    if (passOnly || LABEL_ONLY.test(bare)) {
      // 下の値の行（空行は 2 行まで飛ばす）
      let j = i + 1;
      while (j < lines.length && j <= i + 3 && !lines[j].trim()) j++;
      const nx = (lines[j] ?? "").trim().replace(/\\(?=[!_*#\-.])/g, "");
      if (j < lines.length && j <= i + 3 && nx !== MASK && !LABEL_ONLY.test(nx)
        && (EMAIL_RE.test(nx) || isToken(nx) || (passOnly && !/\s/.test(nx) && nx.length <= 64 && !/^https?:/.test(nx)))) {
        EMAIL_RE.lastIndex = 0;
        lines[j] = MASK;
        count++;
        i = j;
      }
      EMAIL_RE.lastIndex = 0;
    }
  }
  return { text: lines.join("\n"), count };
}

/** 前の発言に ID・パスワードの話が出たあと、値だけを 1 通で送った発言（「zeri0318!!」のような 1 語） */
const CRED_TALK = /(ID|ＩＤ|パスワード|パス|pass|PW|ログイン|アカウント|メールアドレス|メアド)/i;
const LONE_SECRET = (b) => {
  const t = b.trim().replace(/\\(?=[!_*#\-.])/g, "");
  return t.length >= 6 && t.length <= 40 && /^[\x21-\x7E]+$/.test(t) && !/^https?:/i.test(t)
    && !/^%[^%]+%$/.test(t) && !/^\{\{.+\}\}$/.test(t) // UTAGE などの差し込み（%sei_mei% など）は伏せない
    && /[0-9!#$%&*+?@^~_.-]/.test(t) && /[A-Za-z]/.test(t);
};

/**
 * 発言の並びをまとめて伏せる（保存する前に必ず通す）。maskSecrets に加えて、
 * 直前 2 通（同じ人か 30 分以内）に ID・パスワードの話がある「1 語だけの発言」も伏せる。
 * 返り値：{ messages（body を伏せ、masked を付けたもの）, count }
 */
export function maskMessages(msgs: any[]): { messages: any[]; count: number } {
  let count = 0;
  const out = [];
  const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || "") ? Number(t.slice(0, -3)) * 60 + Number(t.slice(-2)) : null);
  const credTalk = (body) => { EMAIL_RE.lastIndex = 0; const r = CRED_TALK.test(body) || EMAIL_RE.test(body); EMAIL_RE.lastIndex = 0; return r; };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const r = maskSecrets(m.body);
    let body = r.text, n = r.count;
    const prev = msgs.slice(Math.max(0, i - 2), i).filter((p) => p.day === m.day
      && (p.who === m.who || (toMin(m.time) != null && toMin(p.time) != null && toMin(m.time) - toMin(p.time) <= 30)));
    if (prev.some((p) => credTalk(p.body)) || credTalk(m.body)) {
      const lines = body.split("\n");
      for (let k = 0; k < lines.length; k++) {
        if (lines[k] !== MASK && LONE_SECRET(lines[k])) { lines[k] = MASK; n++; }
      }
      body = lines.join("\n");
    }
    count += n;
    out.push({ ...m, body, masked: n > 0 });
  }
  return { messages: out, count };
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
