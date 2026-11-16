/**
 * スキルを生徒に出す（public の枝へ写す）前の確かめと、頭の欄の書き換えの計算だけ（2026-11-16 v1.117.0 開発部・Naoki OK 15:00）。
 * GitHub に触らない。skills__publish・skills__unpublish が使う。
 *
 * 出す前の 3 つ：
 *   ① 中身に内部の情報が無いか（入れてはいけないファイル＝止める／内部の言葉＝人が見てから OK）
 *   ② そのスキルが呼ぶスキル（refs）も生徒の版にあるか（同じ回に一緒に出すものも数える）
 *   ③ 出す相手（門番の表のキー）を人が指定したか
 */

/** 社内の印（skills-zip.ts の INTERNAL_AUDIENCE と同じ。試験で読み込めるよう、ここでも持つ） */
const INTERNAL_AUDIENCE = ["本人", "事業部"];

/** 生徒の版に入れてはいけないファイル（Naoki の仮説・X のコードの数字の読み・直しの記録）。見つけたら出さない */
export const INTERNAL_FILES = [/(^|\/)hypotheses\.md$/i, /(^|\/)code-facts\.md$/i, /(^|\/)code-changes\.md$/i, /(^|\/)feedback\//i];

/** 内部の言葉（クライアント・スタッフ・本名・連絡先・本人用の道具）。見つけたら人に見せ、OK が出るまで出さない */
export const INTERNAL_WORDS: Array<{ re: RegExp; why: string }> = [
  { re: /るーみん|岩永|留美/, why: "クライアントの名前" },
  { re: /サンリット|Sunlit/i, why: "クライアントの名前" },
  { re: /おかぜり|るりさん/, why: "スタッフ・関係者の名前" },
  { re: /竹林|Takebayashi/i, why: "本名" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, why: "メールアドレス" },
  { re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*__[a-z_]+\b/, why: "本人用の道具（shia2n-mcp）の名前。生徒はこの道具を使えない" },
  { re: /shia2n-mcp|ContentOS|コンテンツくん|haAku|TaskMaster|Buffer/, why: "本人用のアプリの名前" },
];

export const GATE_KEY_RE = /^[a-z0-9_]{2,40}$/;

export type Hit = { file: string; line: number; why: string; text: string };

export function scanInternal(files: Array<{ path: string; text: string | null }>): { blocked: string[]; hits: Hit[] } {
  const blocked: string[] = [];
  const hits: Hit[] = [];
  for (const f of files) {
    if (INTERNAL_FILES.some((re) => re.test(f.path))) { blocked.push(f.path); continue; }
    if (f.text === null) continue;
    f.text.split(/\r?\n/).forEach((ln, i) => {
      for (const w of INTERNAL_WORDS) {
        if (w.re.test(ln)) { hits.push({ file: f.path, line: i + 1, why: w.why, text: ln.trim().slice(0, 120) }); break; }
      }
    });
  }
  return { blocked, hits };
}

/** 呼ぶスキルのうち、生徒の版に無く、同じ回にも出さないもの */
export function missingRefs(refs: string[], publicNames: string[], publishing: string[]): string[] {
  const ok = new Set([...publicNames, ...publishing]);
  return refs.filter((r) => !ok.has(r));
}

/** 出す相手のキーを確かめる。本人・事業部は社内の印なので、生徒に出す先には数えない */
export function checkKeys(keys: string[]): { keys: string[]; bad: string[] } {
  const k = [...new Set(keys.map((x) => x.trim()).filter(Boolean))];
  const bad = k.filter((x) => INTERNAL_AUDIENCE.includes(x) || !GATE_KEY_RE.test(x));
  return { keys: k.filter((x) => !bad.includes(x)), bad };
}

/** 頭の metadata の 1 行を書き換える（value が null なら消す・無ければ足す）。本文には触らない */
export function setMeta(text: string, key: string, value: string | null): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const head = m[1];
  const re = new RegExp(`^([ \\t]+)${key}:.*(?:\\r?\\n|$)`, "m");
  let next: string;
  if (re.test(head)) next = value === null ? head.replace(re, "") : head.replace(re, (_l, sp) => `${sp}${key}: "${value}"\n`);
  else if (value === null) next = head;
  else next = /^metadata:\s*$/m.test(head) ? head.replace(/^metadata:\s*\r?\n/m, (x) => `${x}  ${key}: "${value}"\n`) : `${head}\nmetadata:\n  ${key}: "${value}"`;
  next = next.replace(/\n+$/, "");
  return text.slice(0, m.index) + `---\n${next}\n---` + text.slice(m.index + m[0].length);
}

/** 見せる相手の欄を、社内の印は残したまま、生徒のキーだけ keys に置き換える */
export function audienceWith(current: string[], keys: string[]): string {
  const inside = current.filter((a) => INTERNAL_AUDIENCE.includes(a));
  return [...new Set([...inside, ...keys])].join(", ");
}
