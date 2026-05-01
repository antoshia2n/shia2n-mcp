/**
 * TaskMaster Firestore 読み取りエンドポイント
 * GET /taskmaster/tasks
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

async function getFirestoreToken(env: Env): Promise<string> {
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

  // PEM → DER（Cloudflare Workers の環境変数では \n がリテラルになっているため置換）
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
    // "2026-05-10T00:00:00Z" → "2026-05-10"
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
// Firestore ドキュメント取得
// ─────────────────────────────────────────────

type FirestoreDoc = {
  name: string;
  fields?: Record<string, FirestoreTypedValue>;
};

/**
 * users/{uid}/app_data/{docName} を取得する。
 *
 * TaskMaster はタスク/プロジェクトを
 *   users/{uid}/app_data/tasks     （ドキュメント）のフィールドに保存 … パターン A
 *   users/{uid}/app_data/tasks/{id} （サブコレクション内の個別ドキュメント） … パターン B
 * のどちらかを使っている可能性がある。
 *
 * Firestore REST API のセグメント数ルール：
 *   users/{uid}/app_data/tasks = 4 セグメント（偶数）→ ドキュメント GET
 *   users/{uid}/app_data/tasks/{id} = 5 セグメント（奇数）→ コレクション LIST は別エンドポイント
 *
 * ここではまずドキュメント GET を試み、フィールドを返す。
 * フィールドが空 or 404 の場合はサブコレクション LIST にフォールバックする。
 */
async function fetchFirestoreData(
  accessToken: string,
  uid: string,
  docName: "tasks" | "projects"
): Promise<{ docs: FirestoreDoc[]; mode: "single-doc" | "collection" }> {
  const baseUrl = `${FIRESTORE_BASE}/users/${uid}/app_data/${docName}`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  // まずドキュメント GET を試みる（パターン A）
  const docRes = await fetch(baseUrl, { headers });

  if (docRes.ok) {
    const docData = (await docRes.json()) as FirestoreDoc;
    if (docData.fields && Object.keys(docData.fields).length > 0) {
      return { docs: [docData], mode: "single-doc" };
    }
  }

  // フォールバック：サブコレクション LIST（パターン B）
  // users/{uid}/app_data を parent として tasks サブコレクションをリスト
  const listUrl =
    `${FIRESTORE_BASE}/users/${uid}/app_data` +
    `?pageSize=500&showMissing=false`;
  // NOTE: Firestore list API では parent + collectionId の形式を使う。
  // REST では parent ドキュメントの名前を指定し、collectionId クエリパラメータは存在しない。
  // 代わりに collectionId フィルタは runQuery で行う。
  // シンプルに tasks サブコレクションを直接 GET する。
  const subColUrl = `${FIRESTORE_BASE}/users/${uid}/app_data/${docName}?pageSize=500`;
  const colRes = await fetch(subColUrl, { headers });

  if (colRes.ok) {
    const colData = (await colRes.json()) as {
      documents?: FirestoreDoc[];
    };
    if (colData.documents && colData.documents.length > 0) {
      return { docs: colData.documents, mode: "collection" };
    }
  }

  return { docs: [], mode: "collection" };
}

// ─────────────────────────────────────────────
// ドキュメントパスからIDを抽出
// ─────────────────────────────────────────────

function docToId(name: string): string {
  return name.split("/").pop() ?? name;
}

// ─────────────────────────────────────────────
// ドキュメントデータ → タスク/プロジェクト変換
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

function extractTasks(
  docs: FirestoreDoc[],
  mode: "single-doc" | "collection"
): TaskRecord[] {
  const results: TaskRecord[] = [];

  if (mode === "single-doc" && docs[0]?.fields) {
    // パターン A：1 ドキュメントのフィールドが各タスク（mapValue）
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
    // パターン B：各ドキュメントが 1 タスク
    for (const doc of docs) {
      const f = doc.fields ?? {};
      const archived = fromFirestoreValue(f.archived ?? { booleanValue: false }) as boolean;
      const completed = fromFirestoreValue(f.completed ?? { booleanValue: false }) as boolean;
      if (archived || completed) continue;
      results.push({
        id: docToId(doc.name),
        title: (fromFirestoreValue(f.title ?? { stringValue: "" }) as string),
        status: (fromFirestoreValue(f.status ?? { stringValue: "todo" }) as string),
        priority: (fromFirestoreValue(f.priority ?? { stringValue: "medium" }) as string),
        deadline: (fromFirestoreValue(f.deadline ?? { nullValue: null }) as string | null),
        groupId: (fromFirestoreValue(f.groupId ?? { nullValue: null }) as string | null),
        projectId: (fromFirestoreValue(f.projectId ?? { nullValue: null }) as string | null),
      });
    }
  }

  return results;
}

function extractProjects(
  docs: FirestoreDoc[],
  mode: "single-doc" | "collection"
): ProjectRecord[] {
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
        title: (fromFirestoreValue(f.title ?? { stringValue: "" }) as string),
        status: (fromFirestoreValue(f.status ?? { stringValue: "" }) as string),
        endDate: (fromFirestoreValue(f.endDate ?? { nullValue: null }) as string | null),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────
// エンドポイントハンドラー（index.ts から呼ぶ）
// ─────────────────────────────────────────────

export async function handleTaskmasterTasks(
  _req: Request,
  env: Env
): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid) {
    return Response.json(
      { error: "NAOKI_UID not configured" },
      { status: 500 }
    );
  }
  if (!env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json(
      { error: "Firebase Service Account not configured" },
      { status: 500 }
    );
  }

  // Firebase アクセストークン取得
  let accessToken: string;
  try {
    accessToken = await getFirestoreToken(env);
  } catch (e) {
    return Response.json(
      { error: "Firebase auth failed", detail: String(e) },
      { status: 500 }
    );
  }

  // tasks / projects を並列取得
  let taskResult: { docs: FirestoreDoc[]; mode: "single-doc" | "collection" };
  let projectResult: { docs: FirestoreDoc[]; mode: "single-doc" | "collection" };
  try {
    [taskResult, projectResult] = await Promise.all([
      fetchFirestoreData(accessToken, uid, "tasks"),
      fetchFirestoreData(accessToken, uid, "projects"),
    ]);
  } catch (e) {
    return Response.json(
      { error: "Firestore fetch failed", detail: String(e) },
      { status: 500 }
    );
  }

  const tasks = extractTasks(taskResult.docs, taskResult.mode);
  const projects = extractProjects(projectResult.docs, projectResult.mode);

  return Response.json({ tasks, projects });
}
