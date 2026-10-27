/**
 * Firestore の利用者（users）の戻す試し（2026-10-28 開発部・ポータルの関門 6）。
 *
 * 決めごと：
 *   1. 書き戻す先は必ず users_restore_test。本番の users には書かない（名前はこちらで決め、呼ぶ側から変えられない）
 *   2. 書き戻して件数を数えたら、試しの置き場は消す（利用者の情報の写しを残さない）
 *   3. 何回動かしても同じ結果になる（先に試しの置き場を空にしてから入れる）
 * 控えの形は cron-backup.ts の users と同じ：{ collection: "users", documents: [{ name, fields }] }
 */
import type { Env } from "./index.js";

const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";
const FIREBASE_DB_ID = "ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
export const FIRESTORE_DOCS =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/${FIREBASE_DB_ID}/documents`;
export const TEST_COLLECTION = "users_restore_test";
const MAX_DOCS = 2000;

type Doc = { name?: string; fields?: Record<string, unknown> };

/** 文書の名前の最後（利用者の番号）。形が違えば null */
export function docId(name: unknown): string | null {
  const s = String(name ?? "");
  const id = s.slice(s.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) && s.includes("/documents/users/") ? id : null;
}

async function listIds(base: string, token: string, f: typeof fetch): Promise<string[] | null> {
  const ids: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 20; i++) {
    const r = await f(`${base}/${TEST_COLLECTION}?pageSize=300&mask.fieldPaths=__name__${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { documents?: Doc[]; nextPageToken?: string };
    for (const d of j.documents ?? []) { const s = String(d.name ?? ""); ids.push(s.slice(s.lastIndexOf("/") + 1)); }
    if (!j.nextPageToken) return ids;
    pageToken = j.nextPageToken;
  }
  return ids;
}

async function clear(base: string, token: string, f: typeof fetch): Promise<boolean> {
  const ids = await listIds(base, token, f);
  if (ids === null) return false;
  for (const id of ids) {
    const r = await f(`${base}/${TEST_COLLECTION}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok && r.status !== 404) return false;
  }
  return true;
}

export async function restoreFirestoreUsers(opts: {
  env: Env; table: string; date: string; getToken: () => Promise<string>; fetchFn?: typeof fetch; base?: string;
}): Promise<Record<string, unknown>> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.base ?? FIRESTORE_DOCS;
  const key = `backup/${opts.date}/firestore/users.json`;
  const out: Record<string, unknown> = { 控えの場所: key, 戻す先: `Firestore の ${TEST_COLLECTION}（数えたら消す）` };
  if (opts.table !== "users") { out.結果 = "止めた"; out.理由 = "Firestore で戻せるのは users だけ"; return out; }
  try {
    const obj = await opts.env.BACKUP_BUCKET.get(key);
    if (!obj) { out.結果 = "止めた"; out.理由 = "その日の控えに users が無い（控えに入るのは 2026-10-28 の夜の回から）"; return out; }
    const parsed = JSON.parse(await obj.text()) as { documents?: Doc[] };
    const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
    out.控えの件数 = docs.length;
    if (docs.length > MAX_DOCS) { out.結果 = "止めた"; out.理由 = `件数が多すぎる（${docs.length} 件・上限 ${MAX_DOCS} 件）`; return out; }
    const token = await opts.getToken();
    if (!(await clear(base, token, f))) { out.結果 = "止めた"; out.理由 = "試しの置き場を空にできなかった"; return out; }
    let 書き戻した = 0;
    const 失敗: string[] = [];
    for (const d of docs) {
      const id = docId(d.name);
      if (!id) { 失敗.push("名前の形が違う文書を 1 件飛ばした"); continue; }
      const r = await f(`${base}/${TEST_COLLECTION}/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: d.fields ?? {} }),
      });
      if (r.ok) 書き戻した++; else 失敗.push(`${r.status}`);
    }
    out.書き戻した件数 = 書き戻した;
    if (失敗.length) out.失敗 = 失敗.slice(0, 10);
    const after = await listIds(base, token, f);
    out.戻したあとの件数 = after === null ? null : after.length;
    out.件数が一致したか = after !== null && after.length === docs.length;
    out.結果 = out.件数が一致したか ? "戻せた（件数が一致）" : "戻し切れていない";
    out.試しの置き場を消した = await clear(base, token, f);
    return out;
  } catch (e) {
    out.結果 = "止めた";
    out.理由 = e instanceof Error ? e.message : String(e);
    return out;
  }
}
