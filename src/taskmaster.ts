/**
 * TaskMaster Firestore 読み取りエンドポイント
 * GET /taskmaster/tasks  — 未完了タスク・プロジェクト一覧
 * GET /taskmaster/diag   — 診断（認証不要）
 *
 * Firebase Admin SDK 不使用。
 * crypto.subtle（Cloudflare Workers ネイティブ）で JWT 署名し
 * Firestore REST API に直接アクセスする。
 *
 * データ構造（診断で確認済み）：
 *   users/{uid}/app_data/tasks    → フィールド "value" の中にタスクデータ
 *   users/{uid}/app_data/projects → フィールド "value" の中にプロジェクトデータ
 */

import { Env } from "./index.js";

const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";
const FIREBASE_DB_ID = "ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
  `/databases/${FIREBASE_DB_ID}/documents`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─────────────────────────────────────────────
// Firebase 認証
// ─────────────────────────────────────────────

export async function getFirestoreToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const b64url = (obj: object): string =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const signingInput =
    `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: env.FIREBASE_SA_EMAIL,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })}`;

  const pem = env.FIREBASE_SA_PRIVATE_KEY.replace(/\\n/g, "\n");
  const pemBody = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" +
      `&assertion=${signingInput}.${sigB64}`,
  });

  if (!tokenRes.ok) {
    throw new Error(`Token fetch failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

// ─────────────────────────────────────────────
// Firestore 型変換
// ─────────────────────────────────────────────

type FVal = Record<string, unknown>;

function fromVal(val: FVal): unknown {
  if ("stringValue"   in val) return val.stringValue;
  if ("booleanValue"  in val) return val.booleanValue;
  if ("integerValue"  in val) return Number(val.integerValue);
  if ("doubleValue"   in val) return val.doubleValue;
  if ("nullValue"     in val) return null;
  if ("timestampValue" in val) return (val.timestampValue as string).slice(0, 10);
  if ("mapValue" in val) {
    const fields = (val.mapValue as { fields?: Record<string, FVal> }).fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) out[k] = fromVal(v);
    return out;
  }
  if ("arrayValue" in val) {
    const values = (val.arrayValue as { values?: FVal[] }).values ?? [];
    return values.map(fromVal);
  }
  return null;
}

// ─────────────────────────────────────────────
// Firestore ドキュメント取得
// ─────────────────────────────────────────────

type FSDoc = { name: string; fields?: Record<string, FVal> };

async function fsGet(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

// ─────────────────────────────────────────────
// "value" フィールドの展開
//
// tasks / projects ドキュメントは以下の構造：
//   { fields: { value: <arrayValue or mapValue> } }
//
// arrayValue → 各要素が 1 タスク/プロジェクトのマップ
// mapValue   → キーが ID、値がタスク/プロジェクトのマップ
// ─────────────────────────────────────────────

type Item = Record<string, unknown>;

function expandValueField(doc: FSDoc): Item[] {
  const fields = doc.fields ?? {};

  // "value" フィールドが存在する場合
  if ("value" in fields) {
    const expanded = fromVal(fields.value);

    // arrayValue → [{id?, title?, ...}, ...]
    if (Array.isArray(expanded)) {
      return expanded.filter((v): v is Item => typeof v === "object" && v !== null) as Item[];
    }

    // mapValue → { id1: {...}, id2: {...} }
    if (typeof expanded === "object" && expanded !== null) {
      return Object.entries(expanded as Record<string, unknown>).map(([id, v]) => ({
        id,
        ...(typeof v === "object" && v !== null ? (v as Item) : {}),
      }));
    }
  }

  // "value" フィールドがない場合：フィールドキーをIDとして扱う従来パターン
  return Object.entries(fields).map(([id, val]) => {
    const v = fromVal(val);
    return typeof v === "object" && v !== null ? { id, ...(v as Item) } : { id };
  });
}

// ─────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────

type TaskRecord = {
  id: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  groupId: string | null;
  projectId: string | null;
};

type ProjectRecord = {
  id: string;
  title: string;
  status: string;
  endDate: string | null;
};

function str(v: unknown, def = ""): string {
  return typeof v === "string" ? v : def;
}
function nullStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function bool(v: unknown, def = false): boolean {
  return typeof v === "boolean" ? v : def;
}

// ─────────────────────────────────────────────
// GET /taskmaster/tasks
// ─────────────────────────────────────────────

export async function handleTaskmasterTasks(_req: Request, env: Env): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "env not configured" }, { status: 500 });
  }

  let token: string;
  try { token = await getFirestoreToken(env); }
  catch (e) { return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 }); }

  let tasksDoc: FSDoc, projectsDoc: FSDoc;
  try {
    const [tr, pr] = await Promise.all([
      fsGet(token, `users/${uid}/app_data/tasks`),
      fsGet(token, `users/${uid}/app_data/projects`),
    ]);
    tasksDoc    = tr.body as FSDoc;
    projectsDoc = pr.body as FSDoc;
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const rawTasks    = expandValueField(tasksDoc);
  const rawProjects = expandValueField(projectsDoc);

  const tasks: TaskRecord[] = rawTasks
    .filter((t) => !bool(t.archived) && !bool(t.completed))
    .map((t) => ({
      id:        str(t.id ?? t.taskId),
      title:     str(t.title),
      status:    str(t.status, "todo"),
      priority:  str(t.priority, "medium"),
      deadline:  nullStr(t.deadline),
      groupId:   nullStr(t.groupId),
      projectId: nullStr(t.projectId),
    }));

  const projects: ProjectRecord[] = rawProjects.map((p) => ({
    id:      str(p.id ?? p.projectId),
    title:   str(p.title),
    status:  str(p.status),
    endDate: nullStr(p.endDate),
  }));

  return Response.json({ tasks, projects });
}

// ─────────────────────────────────────────────
// GET /taskmaster/diag — 認証不要・機密情報は返さない
// ─────────────────────────────────────────────

export async function handleTaskmasterDiag(_req: Request, env: Env): Promise<Response> {
  const result: Record<string, unknown> = {};

  result.env = {
    NAOKI_UID:               env.NAOKI_UID ? `set (${env.NAOKI_UID.length} chars)` : "NOT SET",
    FIREBASE_SA_EMAIL:       env.FIREBASE_SA_EMAIL ? `set → ${env.FIREBASE_SA_EMAIL}` : "NOT SET",
    FIREBASE_SA_PRIVATE_KEY: env.FIREBASE_SA_PRIVATE_KEY
      ? `set (${env.FIREBASE_SA_PRIVATE_KEY.length} chars)`
      : "NOT SET",
  };

  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    result.conclusion = "STOP: 環境変数が未設定。";
    return Response.json(result);
  }

  let token: string;
  try { token = await getFirestoreToken(env); result.firebase_auth = "OK"; }
  catch (e) { result.firebase_auth = `FAILED: ${String(e)}`; return Response.json(result); }

  // tasks ドキュメントの "value" フィールドの型と内容を確認
  try {
    const { status, body } = await fsGet(token, `users/${uid}/app_data/tasks`);
    const doc = body as FSDoc;
    const fields = doc.fields ?? {};
    const valueRaw = fields.value;
    let valueInfo: unknown = "field 'value' not found";

    if (valueRaw) {
      const expanded = fromVal(valueRaw);
      if (Array.isArray(expanded)) {
        valueInfo = {
          type: "array",
          count: expanded.length,
          sample: expanded.slice(0, 2),
        };
      } else if (typeof expanded === "object" && expanded !== null) {
        const entries = Object.entries(expanded as Record<string, unknown>);
        valueInfo = {
          type: "map",
          count: entries.length,
          sampleKeys: entries.slice(0, 5).map(([k]) => k),
          sampleFirstValue: entries[0]?.[1],
        };
      } else {
        valueInfo = { type: typeof expanded, value: expanded };
      }
    }

    result.tasks_doc = { status, fieldKeys: Object.keys(fields), value: valueInfo };
  } catch (e) {
    result.tasks_doc = { error: String(e) };
  }

  result.conclusion = "tasks_doc.value を確認してデータ構造を特定してください。";
  return Response.json(result);
}
