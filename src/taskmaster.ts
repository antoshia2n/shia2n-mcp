/**
 * TaskMaster Firestore 読み取りエンドポイント
 * GET /taskmaster/tasks  — 未完了タスク・プロジェクト一覧
 * GET /taskmaster/diag   — 診断（環境変数・Firestore 疎通・パス特定）
 *
 * Firebase Admin SDK 不使用。
 * crypto.subtle（Cloudflare Workers ネイティブ）で JWT 署名し
 * Firestore REST API に直接アクセスする。
 */

import { Env } from "./index.js";

const FIREBASE_PROJECT_ID = "gen-lang-client-0371348401";
const FIREBASE_DB_ID = "ai-studio-622b9a97-52df-425a-85c6-1a2670c54e0a";
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
  `/databases/${FIREBASE_DB_ID}/documents`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─────────────────────────────────────────────
// Firebase 認証（Service Account → アクセストークン）
// ─────────────────────────────────────────────

export async function getFirestoreToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const b64url = (obj: object): string =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: env.FIREBASE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

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

  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer" +
      `&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token fetch failed: ${tokenRes.status} ${err}`);
  }

  const tokenData = (await tokenRes.json()) as { access_token: string };
  return tokenData.access_token;
}

// ─────────────────────────────────────────────
// Firestore 型変換
// ─────────────────────────────────────────────

type FirestoreTypedValue = Record<string, unknown>;

function fromFirestoreValue(val: FirestoreTypedValue): unknown {
  if ("stringValue" in val) return val.stringValue;
  if ("booleanValue" in val) return val.booleanValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return val.doubleValue;
  if ("nullValue" in val) return null;
  if ("timestampValue" in val) {
    return (val.timestampValue as string).slice(0, 10);
  }
  if ("mapValue" in val) {
    const map = val.mapValue as { fields?: Record<string, FirestoreTypedValue> };
    if (!map.fields) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map.fields)) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  if ("arrayValue" in val) {
    const arr = val.arrayValue as { values?: FirestoreTypedValue[] };
    return (arr.values ?? []).map(fromFirestoreValue);
  }
  return null;
}

// ─────────────────────────────────────────────
// Firestore REST API ヘルパー
// ─────────────────────────────────────────────

type FirestoreDoc = {
  name: string;
  fields?: Record<string, FirestoreTypedValue>;
};

async function firestoreGet(
  accessToken: string,
  path: string
): Promise<{ status: number; body: unknown }> {
  const url = `${FIRESTORE_BASE}/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function firestoreList(
  accessToken: string,
  path: string,
  pageSize = 500
): Promise<{ status: number; body: unknown }> {
  // LIST は奇数セグメントパス（コレクション）に対して使う
  const url = `${FIRESTORE_BASE}/${path}?pageSize=${pageSize}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function firestoreRunQuery(
  accessToken: string,
  parentPath: string,
  collectionId: string,
  limit = 500
): Promise<FirestoreDoc[]> {
  const url = `${FIRESTORE_BASE}/${parentPath}:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId, allDescendants: false }],
        limit,
      },
    }),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{ document?: FirestoreDoc }>;
  return rows.flatMap((r) => (r.document ? [r.document] : []));
}

// ─────────────────────────────────────────────
// データ取得（パターン A / B 自動判別）
// ─────────────────────────────────────────────

async function fetchData(
  accessToken: string,
  uid: string,
  kind: "tasks" | "projects"
): Promise<{ docs: FirestoreDoc[]; mode: "single-doc" | "collection" }> {
  // ① ドキュメント GET（パターン A：1 ドキュメントのフィールドに全データ）
  const { status, body } = await firestoreGet(accessToken, `users/${uid}/app_data/${kind}`);
  if (status === 200) {
    const doc = body as FirestoreDoc;
    if (doc.fields && Object.keys(doc.fields).length > 0) {
      return { docs: [doc], mode: "single-doc" };
    }
  }

  // ② runQuery（パターン B：個別ドキュメントのサブコレクション）
  const docs = await firestoreRunQuery(accessToken, `users/${uid}/app_data`, kind);
  if (docs.length > 0) {
    return { docs, mode: "collection" };
  }

  return { docs: [], mode: "collection" };
}

// ─────────────────────────────────────────────
// ドキュメント → タスク/プロジェクト変換
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

function docToId(name: string): string {
  return name.split("/").pop() ?? name;
}

function getStr(f: Record<string, FirestoreTypedValue>, key: string, def = ""): string {
  return (fromFirestoreValue(f[key] ?? { stringValue: def }) as string) ?? def;
}

function getBool(f: Record<string, FirestoreTypedValue>, key: string, def = false): boolean {
  return (fromFirestoreValue(f[key] ?? { booleanValue: def }) as boolean) ?? def;
}

function getNullableStr(
  f: Record<string, FirestoreTypedValue>,
  key: string
): string | null {
  if (!(key in f)) return null;
  const v = fromFirestoreValue(f[key]);
  return typeof v === "string" ? v : null;
}

function extractTasks(docs: FirestoreDoc[], mode: "single-doc" | "collection"): TaskRecord[] {
  const results: TaskRecord[] = [];

  if (mode === "single-doc" && docs[0]?.fields) {
    for (const [id, val] of Object.entries(docs[0].fields)) {
      const task = fromFirestoreValue(val) as Record<string, unknown>;
      if (task.archived || task.completed) continue;
      results.push({
        id,
        title: (task.title as string) ?? "",
        status: (task.status as string) ?? "todo",
        priority: (task.priority as string) ?? "medium",
        deadline: (task.deadline as string | null) ?? null,
        groupId: (task.groupId as string | null) ?? null,
        projectId: (task.projectId as string | null) ?? null,
      });
    }
  } else {
    for (const doc of docs) {
      const f = doc.fields ?? {};
      if (getBool(f, "archived") || getBool(f, "completed")) continue;
      results.push({
        id: docToId(doc.name),
        title: getStr(f, "title"),
        status: getStr(f, "status", "todo"),
        priority: getStr(f, "priority", "medium"),
        deadline: getNullableStr(f, "deadline"),
        groupId: getNullableStr(f, "groupId"),
        projectId: getNullableStr(f, "projectId"),
      });
    }
  }

  return results;
}

function extractProjects(docs: FirestoreDoc[], mode: "single-doc" | "collection"): ProjectRecord[] {
  const results: ProjectRecord[] = [];

  if (mode === "single-doc" && docs[0]?.fields) {
    for (const [id, val] of Object.entries(docs[0].fields)) {
      const proj = fromFirestoreValue(val) as Record<string, unknown>;
      results.push({
        id,
        title: (proj.title as string) ?? "",
        status: (proj.status as string) ?? "",
        endDate: (proj.endDate as string | null) ?? null,
      });
    }
  } else {
    for (const doc of docs) {
      const f = doc.fields ?? {};
      results.push({
        id: docToId(doc.name),
        title: getStr(f, "title"),
        status: getStr(f, "status"),
        endDate: getNullableStr(f, "endDate"),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// GET /taskmaster/tasks
// ─────────────────────────────────────────────

export async function handleTaskmasterTasks(
  _req: Request,
  env: Env
): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid) return Response.json({ error: "NAOKI_UID not configured" }, { status: 500 });
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "Firebase Service Account not configured" }, { status: 500 });
  }

  let accessToken: string;
  try {
    accessToken = await getFirestoreToken(env);
  } catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  let taskResult: { docs: FirestoreDoc[]; mode: "single-doc" | "collection" };
  let projectResult: { docs: FirestoreDoc[]; mode: "single-doc" | "collection" };
  try {
    [taskResult, projectResult] = await Promise.all([
      fetchData(accessToken, uid, "tasks"),
      fetchData(accessToken, uid, "projects"),
    ]);
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  return Response.json({
    tasks: extractTasks(taskResult.docs, taskResult.mode),
    projects: extractProjects(projectResult.docs, projectResult.mode),
  });
}

// ─────────────────────────────────────────────
// GET /taskmaster/diag — 原因特定用診断エンドポイント
// ─────────────────────────────────────────────

export async function handleTaskmasterDiag(
  _req: Request,
  env: Env
): Promise<Response> {
  const result: Record<string, unknown> = {};

  // 1. 環境変数チェック（値は返さず設定状況のみ）
  result.env = {
    NAOKI_UID: env.NAOKI_UID
      ? `set (${env.NAOKI_UID.length} chars)`
      : "NOT SET",
    FIREBASE_SA_EMAIL: env.FIREBASE_SA_EMAIL
      ? `set → ${env.FIREBASE_SA_EMAIL}`
      : "NOT SET",
    FIREBASE_SA_PRIVATE_KEY: env.FIREBASE_SA_PRIVATE_KEY
      ? `set (${env.FIREBASE_SA_PRIVATE_KEY.length} chars, starts: ${env.FIREBASE_SA_PRIVATE_KEY.slice(0, 27)}...)`
      : "NOT SET",
  };

  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    result.conclusion = "STOP: 環境変数が未設定。";
    return Response.json(result);
  }

  // 2. Firebase トークン取得テスト
  let accessToken: string;
  try {
    accessToken = await getFirestoreToken(env);
    result.firebase_auth = "OK";
  } catch (e) {
    result.firebase_auth = `FAILED: ${String(e)}`;
    result.conclusion = "STOP: Firebase 認証失敗。SA_EMAIL / SA_PRIVATE_KEY を確認。";
    return Response.json(result);
  }

  // 3. パス別 GET テスト
  const getTests: Record<string, unknown> = {};
  for (const p of [
    `users/${uid}`,
    `users/${uid}/app_data/tasks`,
    `users/${uid}/app_data/projects`,
  ]) {
    try {
      const { status, body } = await firestoreGet(accessToken, p);
      const doc = body as FirestoreDoc;
      getTests[p] = {
        status,
        fieldCount: doc.fields ? Object.keys(doc.fields).length : 0,
        fieldKeys: doc.fields ? Object.keys(doc.fields).slice(0, 15) : [],
      };
    } catch (e) {
      getTests[p] = { error: String(e) };
    }
  }
  result.get_tests = getTests;

  // 4. LIST テスト（奇数セグメント）
  const listTests: Record<string, unknown> = {};
  for (const p of [`users/${uid}/app_data`]) {
    try {
      const { status, body } = await firestoreList(accessToken, p, 20);
      const lb = body as { documents?: FirestoreDoc[] };
      listTests[p] = {
        status,
        documentCount: (lb.documents ?? []).length,
        documentIds: (lb.documents ?? []).slice(0, 10).map((d) => d.name.split("/").pop()),
      };
    } catch (e) {
      listTests[p] = { error: String(e) };
    }
  }
  result.list_tests = listTests;

  // 5. runQuery テスト（複数のコレクション ID を試す）
  const queryTests: Record<string, unknown> = {};
  for (const colId of ["tasks", "projects", "task", "project", "items", "data"]) {
    try {
      const docs = await firestoreRunQuery(accessToken, `users/${uid}/app_data`, colId, 3);
      if (docs.length > 0) {
        queryTests[`app_data → ${colId}`] = {
          found: docs.length,
          sampleFieldKeys: docs[0].fields ? Object.keys(docs[0].fields).slice(0, 15) : [],
        };
      }
    } catch (_) {
      // 無視して次へ
    }
  }
  result.query_tests = queryTests;

  result.conclusion =
    "get_tests・list_tests・query_tests を確認し、データが見つかるパスを特定してください。";

  return Response.json(result);
}
