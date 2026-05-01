/**
 * TaskMaster Firestore 読み取りエンドポイント
 * GET /taskmaster/tasks  — 未完了タスク・プロジェクト一覧（Bearer 認証必須）
 * GET /taskmaster/diag   — 診断（認証不要）
 *
 * データ構造（診断で確認済み）：
 *   users/{uid}/app_data/tasks    → fields.value が arrayValue（562件）
 *   users/{uid}/app_data/projects → fields.value が arrayValue
 *   各タスクオブジェクトに id / archived / completed / title / status / priority 等が入る
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
  if ("stringValue"    in val) return val.stringValue;
  if ("booleanValue"   in val) return val.booleanValue;
  if ("integerValue"   in val) return Number(val.integerValue);
  if ("doubleValue"    in val) return val.doubleValue;
  if ("nullValue"      in val) return null;
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

async function fsGet(token: string, path: string): Promise<FSDoc> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status}`);
  return res.json() as Promise<FSDoc>;
}

// ─────────────────────────────────────────────
// value フィールドを Item[] に展開
//
// 確認済み構造：
//   fields.value = arrayValue → 各要素が 1 タスクのマップ
//   各タスクは id / title / status / priority / deadline / archived / completed 等を持つ
// ─────────────────────────────────────────────

type Item = Record<string, unknown>;

function expandValue(doc: FSDoc): Item[] {
  const fields = doc.fields ?? {};

  if (!("value" in fields)) {
    // value フィールドがない場合：フィールドキーを ID として扱う旧パターン
    return Object.entries(fields).map(([id, val]) => {
      const v = fromVal(val);
      return typeof v === "object" && v !== null ? { id, ...(v as Item) } : { id };
    });
  }

  const expanded = fromVal(fields.value as FVal);

  if (Array.isArray(expanded)) {
    // arrayValue：各要素が 1 タスク（id フィールドを内包）
    return (expanded as unknown[]).filter(
      (v): v is Item => typeof v === "object" && v !== null
    ) as Item[];
  }

  if (typeof expanded === "object" && expanded !== null) {
    // mapValue：キーが ID、値がタスクデータ
    return Object.entries(expanded as Record<string, unknown>).map(([id, v]) => ({
      id,
      ...(typeof v === "object" && v !== null ? (v as Item) : {}),
    }));
  }

  return [];
}

// ─────────────────────────────────────────────
// 型定義・変換ヘルパー
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
  return typeof v === "string" && v ? v : def;
}
function nullStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

function toTask(t: Item): TaskRecord {
  return {
    id:        str(t.id ?? t.taskId),
    title:     str(t.title),
    status:    str(t.status, "todo"),
    priority:  str(t.priority, "medium"),
    deadline:  nullStr(t.deadline),
    groupId:   nullStr(t.groupId),
    projectId: nullStr(t.projectId),
  };
}

function toProject(p: Item): ProjectRecord {
  return {
    id:      str(p.id ?? p.projectId),
    title:   str(p.title),
    status:  str(p.status),
    endDate: nullStr(p.endDate),
  };
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
  catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  let tasksDoc: FSDoc, projectsDoc: FSDoc;
  try {
    [tasksDoc, projectsDoc] = await Promise.all([
      fsGet(token, `users/${uid}/app_data/tasks`),
      fsGet(token, `users/${uid}/app_data/projects`),
    ]);
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const tasks: TaskRecord[] = expandValue(tasksDoc)
    .filter((t) => !bool(t.archived) && !bool(t.completed))
    .map(toTask);

  const projects: ProjectRecord[] = expandValue(projectsDoc).map(toProject);

  return Response.json({ tasks, projects });
}

// ─────────────────────────────────────────────
// GET /taskmaster/diag — 認証不要・変換サンプル付き
// ─────────────────────────────────────────────

export async function handleTaskmasterDiag(_req: Request, env: Env): Promise<Response> {
  const result: Record<string, unknown> = {};

  result.env = {
    NAOKI_UID:               env.NAOKI_UID ? `set (${env.NAOKI_UID.length} chars)` : "NOT SET",
    FIREBASE_SA_EMAIL:       env.FIREBASE_SA_EMAIL ? `set → ${env.FIREBASE_SA_EMAIL}` : "NOT SET",
    FIREBASE_SA_PRIVATE_KEY: env.FIREBASE_SA_PRIVATE_KEY
      ? `set (${env.FIREBASE_SA_PRIVATE_KEY.length} chars)` : "NOT SET",
  };

  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    result.conclusion = "STOP: 環境変数が未設定。";
    return Response.json(result);
  }

  let token: string;
  try { token = await getFirestoreToken(env); result.firebase_auth = "OK"; }
  catch (e) { result.firebase_auth = `FAILED: ${String(e)}`; return Response.json(result); }

  // tasks ドキュメント取得 + 変換処理を実行してサンプルを表示
  try {
    const tasksDoc = await fsGet(token, `users/${uid}/app_data/tasks`);
    const allItems = expandValue(tasksDoc);
    const active   = allItems.filter((t) => !bool(t.archived) && !bool(t.completed));
    const mapped   = active.slice(0, 5).map(toTask);

    result.tasks = {
      total_in_array:   allItems.length,
      active_count:     active.length,   // archived:false && completed:false
      sample_converted: mapped,          // 変換後の形式（最大5件）
    };
  } catch (e) {
    result.tasks = { error: String(e) };
  }

  // projects ドキュメント取得
  try {
    const projectsDoc = await fsGet(token, `users/${uid}/app_data/projects`);
    const allProjects = expandValue(projectsDoc);
    result.projects = {
      total_count:      allProjects.length,
      sample_converted: allProjects.slice(0, 3).map(toProject),
    };
  } catch (e) {
    result.projects = { error: String(e) };
  }

  result.conclusion = "tasks.active_count > 0 かつ sample_converted に正しいデータが入っていれば /taskmaster/tasks も正常に動作します。";

  return Response.json(result);
}
