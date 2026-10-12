/**
 * shia2n-mcp / src/haaku-deps.ts / 新設（2026-10-12 v1.11.0 開発部）
 *
 * haAku のマイルストーンの「前のマス」を複数持てるようにする（依頼 https://www.notion.so/3f79c6c1c43981aba338e41655cd109d）。
 *
 *   新しい欄 dependsOnIds … 前のマスの ID の配列（0〜10 件・重複なし）
 *   古い欄   dependsOn    … 消さない。配列の 1 つ目を入れ続ける（haAku 本体の画面が文字列 1 つとして読み続けるため）
 *
 * 読み方（ここ 1 か所に寄せる。ホームの計算・書き込みの検め・概要の表示が同じ読み方をするため）
 *   dependsOnIds が配列なら、それが正。dependsOn がその中に無ければ先頭に足し、mismatch を立てる
 *     （画面が dependsOn だけを書き換えた場合に、画面で付けた前のマスを落とさないため）
 *   dependsOnIds が無ければ、dependsOn 1 つ（空なら 0 件）
 */

type Row = Record<string, unknown>;
export const MAX_DEPS = 10;
const REF = /^[A-Za-z0-9_-]{1,180}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export type Deps = { ids: string[]; mismatch: boolean };

/** 保存されているマイルストーン 1 件から、前のマスの並びを読む */
export function depsOf(m: Row | undefined | null): Deps {
  if (!m) return { ids: [], mismatch: false };
  const legacy = str(m.dependsOn);
  const raw = m.dependsOnIds;
  if (!Array.isArray(raw)) return { ids: legacy ? [legacy] : [], mismatch: false };
  const ids: string[] = [];
  for (const v of raw) {
    const s = str(v);
    if (s && !ids.includes(s)) ids.push(s);
  }
  const mismatch = legacy !== (ids[0] ?? "");
  if (legacy && !ids.includes(legacy)) ids.unshift(legacy);
  return { ids, mismatch };
}

/** 書き込みで受け取る dependsOnIds（JSON の文字列）を配列に直す */
export function parseDepIds(raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("前のマイルストーン（dependsOnIds）は JSON の配列（[\"id\", …]）で渡してください"); }
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string" || !REF.test(v))) {
    throw new Error("前のマイルストーン（dependsOnIds）は ID の文字列の配列で渡してください");
  }
  if (parsed.length > MAX_DEPS) throw new Error("前のマイルストーンは " + MAX_DEPS + " 件までです");
  if (new Set(parsed).size !== parsed.length) throw new Error("前のマイルストーンに同じ ID が重複しています");
  return parsed as string[];
}

/**
 * id から前へたどれる全部のマス（近い順・重複なし）。見つからない ID は数えずに飛ばす。
 * 循環していれば止める（いまの決めのまま：循環は断る）
 */
export function ancestorsOf(deps: Map<string, string[]>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // 循環の検め：深さ優先で、いまたどっている道の上に戻ってきたら止める
  const onPath = new Set<string>();
  const done = new Set<string>();
  const walk = (cur: string, path: string[]) => {
    if (onPath.has(cur)) {
      throw new Error("マイルストーンの前のマス（dependsOn）が循環しています：" + [...path, cur].join(" → "));
    }
    if (done.has(cur)) return;
    onPath.add(cur);
    for (const p of deps.get(cur) ?? []) if (deps.has(p)) walk(p, [...path, cur]);
    onPath.delete(cur);
    done.add(cur);
  };
  walk(id, []);
  // 近い順（幅優先）に並べる
  let layer = (deps.get(id) ?? []).filter(p => deps.has(p));
  while (layer.length) {
    const nextLayer: string[] = [];
    for (const p of layer) {
      if (seen.has(p) || p === id) continue;
      seen.add(p);
      out.push(p);
      for (const q of deps.get(p) ?? []) if (deps.has(q)) nextLayer.push(q);
    }
    layer = nextLayer;
  }
  return out;
}
