/**
 * TaskMaster Firestore 読み取り／書き込みエンドポイント
 * GET  /taskmaster/tasks       — 未完了タスク・プロジェクト一覧（Bearer 認証必須）
 * POST /taskmaster/tasks       — タスク新規追加（Bearer 認証必須）
 * POST /taskmaster/tasks/update — タスク更新（Bearer 認証必須）
 * GET  /taskmaster/diag        — 診断（Bearer 認証必須）
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
// Firestore 型変換（読み取り）
// ─────────────────────────────────────────────

export type FVal = Record<string, unknown>;

export function fromVal(val: FVal): unknown {
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
// Firestore 型変換（書き込み）
// ─────────────────────────────────────────────

export function toFVal(v: unknown): FVal {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFVal) } };
  }
  if (typeof v === "object") {
    const fields: Record<string, FVal> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      fields[k] = toFVal(val);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// ─────────────────────────────────────────────
// Firestore ドキュメント取得
// ─────────────────────────────────────────────

export type FSDoc = { name: string; fields?: Record<string, FVal> };

export async function fsGet(token: string, path: string): Promise<FSDoc> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status}`);
  return res.json() as Promise<FSDoc>;
}

// ─────────────────────────────────────────────
// Firestore ドキュメント更新（PATCH + updateMask）
// ─────────────────────────────────────────────

export async function fsPatch(
  token: string,
  path: string,
  fields: Record<string, FVal>,
  updateMask: string[]
): Promise<FSDoc> {
  const maskQuery = updateMask
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join("&");
  const res = await fetch(`${FIRESTORE_BASE}/${path}?${maskQuery}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    throw new Error(`Firestore PATCH ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<FSDoc>;
}

// ─────────────────────────────────────────────
// タスクの置き場の形（2026-10-02 開発部）
//   version 2：タスクは users/{uid}/tm_tasks/{id} に 1 本ずつ。目印は app_data/tm_layout の value.version
//   それより前：users/{uid}/app_data/tasks の value（配列 1 本）
//   移している途中（value.migrating）は書き込みを断る（移した後の写しから漏れないようにするため）
// ─────────────────────────────────────────────

type Layout = "v1" | "v2" | "migrating";

export async function fsGetOrNull(token: string, path: string): Promise<FSDoc | null> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status}`);
  return res.json() as Promise<FSDoc>;
}

export async function readLayout(token: string, uid: string): Promise<Layout> {
  const doc = await fsGetOrNull(token, `users/${uid}/app_data/tm_layout`);
  const v = doc?.fields?.value ? (fromVal(doc.fields.value as FVal) as Record<string, unknown> | null) : null;
  if (v && v.version === 2) return "v2";
  if (v && v.migrating === true) return "migrating";
  return "v1";
}

const MIGRATING = { error: "TaskMaster の置き場を移している途中です。1 分ほどおいてもう一度呼んでください", code: "migrating" };

function docToItem(d: FSDoc): Item {
  const out: Item = {};
  for (const [k, v] of Object.entries(d.fields ?? {})) out[k] = fromVal(v);
  if (!out.id) out.id = d.name.split("/").pop();
  return out;
}

// 1 本ずつの置き場を条件で引く（equality 1 つだけ）
async function queryTasks(token: string, uid: string, field: string, value: FVal): Promise<Item[]> {
  const res = await fetch(`${FIRESTORE_BASE}/users/${uid}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "tm_tasks" }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value } },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore runQuery tm_tasks failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as { document?: FSDoc }[];
  return rows.filter((r) => r.document).map((r) => docToItem(r.document as FSDoc));
}

// 1 本の文書の指定した欄だけを書く（無ければ作る）
async function patchTask(token: string, uid: string, id: string, fields: Item): Promise<void> {
  const f: Record<string, FVal> = {};
  for (const [k, v] of Object.entries(fields)) f[k] = toFVal(v);
  await fsPatch(token, `users/${uid}/tm_tasks/${encodeURIComponent(id)}`, f, Object.keys(fields));
}

// 日本時間の今日（終わった日 doneAt に使う）
function tokyoToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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

  let items: Item[], projectsDoc: FSDoc;
  try {
    const layout = await readLayout(token, uid);
    projectsDoc = await fsGet(token, `users/${uid}/app_data/projects`);
    items = layout === "v2"
      ? await queryTasks(token, uid, "completed", { booleanValue: false })
      : expandValue(await fsGet(token, `users/${uid}/app_data/tasks`));
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const tasks: TaskRecord[] = items
    .filter((t) => !bool(t.archived) && !bool(t.completed))
    .map(toTask);

  const projects: ProjectRecord[] = expandValue(projectsDoc).map(toProject);

  return Response.json({ tasks, projects });
}

// ─────────────────────────────────────────────
// POST /taskmaster/tasks — タスク新規追加
// ─────────────────────────────────────────────

type AddTaskInput = {
  title: string;
  status?: string;
  priority?: string;
  deadline?: string | null;
  groupId?: string | null;
  projectId?: string | null;
};

export async function handleTaskmasterAddTask(req: Request, env: Env): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "env not configured" }, { status: 500 });
  }

  let body: AddTaskInput;
  try {
    body = await req.json() as AddTaskInput;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  let token: string;
  try { token = await getFirestoreToken(env); }
  catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  let layout: Layout;
  try { layout = await readLayout(token, uid); }
  catch (e) { return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 }); }
  if (layout === "migrating") return Response.json(MIGRATING, { status: 503 });

  // 新規タスクオブジェクト
  const newTask: Item = {
    id:        crypto.randomUUID(),
    title:     body.title.trim(),
    status:    body.status ?? "todo",
    priority:  body.priority ?? "medium",
    deadline:  body.deadline ?? null,
    groupId:   body.groupId ?? null,
    projectId: body.projectId ?? null,
    archived:  false,
    completed: false,
    createdAt: new Date().toISOString().slice(0, 10),
  };

  try {
    if (layout === "v2") {
      // 1 本の文書を足すだけ（ほかのタスクは読まない・書かない）
      await patchTask(token, uid, newTask.id as string, { ...newTask, doneAt: "", subtasks: [], notes: "", links: [] });
    } else {
      const existingItems = expandValue(await fsGet(token, `users/${uid}/app_data/tasks`));
      await fsPatch(token, `users/${uid}/app_data/tasks`, { value: toFVal([...existingItems, newTask]) }, ["value"]);
    }
  } catch (e) {
    return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 });
  }

  return Response.json({ ok: true, task: toTask(newTask) }, { status: 201 });
}

// ─────────────────────────────────────────────
// POST /taskmaster/tasks/update — タスク更新
// v0.16.0 で追加
// ─────────────────────────────────────────────

type UpdateTaskInput = {
  task_id: string;
  title?: string;
  status?: string;
  priority?: string;
  deadline?: string | null;
  archived?: boolean;
  projectId?: string | null;
  groupId?: string | null;
};

export async function handleTaskmasterUpdateTask(req: Request, env: Env): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "env not configured" }, { status: 500 });
  }

  let body: UpdateTaskInput;
  try {
    body = await req.json() as UpdateTaskInput;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.task_id || typeof body.task_id !== "string") {
    return Response.json({ error: "task_id is required" }, { status: 400 });
  }

  let token: string;
  try { token = await getFirestoreToken(env); }
  catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  let layout: Layout;
  try { layout = await readLayout(token, uid); }
  catch (e) { return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 }); }
  if (layout === "migrating") return Response.json(MIGRATING, { status: 503 });

  if (layout === "v2") {
    // 1 本の文書の、渡された欄だけを書く。状態を変えたときは画面と同じく完了の印と終わった日もそろえる
    let current: FSDoc | null;
    try { current = await fsGetOrNull(token, `users/${uid}/tm_tasks/${encodeURIComponent(body.task_id)}`); }
    catch (e) { return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 }); }
    if (!current) return Response.json({ error: "task not found", task_id: body.task_id }, { status: 404 });
    const fields: Item = {};
    for (const k of ["title", "status", "priority", "deadline", "archived", "projectId", "groupId"] as const) {
      if (body[k] !== undefined) fields[k] = body[k];
    }
    if (body.status !== undefined) {
      fields.completed = body.status === "done";
      fields.doneAt = body.status === "done" ? tokyoToday() : "";
    }
    try { await patchTask(token, uid, body.task_id, fields); }
    catch (e) { return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 }); }
    return Response.json({ ok: true, task: toTask({ ...docToItem(current), ...fields }) });
  }

  let tasksDoc: FSDoc;
  try {
    tasksDoc = await fsGet(token, `users/${uid}/app_data/tasks`);
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const existingItems = expandValue(tasksDoc);
  const targetIndex = existingItems.findIndex((t) => t.id === body.task_id);
  if (targetIndex === -1) {
    return Response.json({ error: "task not found", task_id: body.task_id }, { status: 404 });
  }

  // 指定フィールドのみ上書き（未指定フィールドは既存値を保持）
  const updated: Item = { ...existingItems[targetIndex] };
  if (body.title     !== undefined) updated.title     = body.title;
  if (body.status    !== undefined) updated.status    = body.status;
  if (body.priority  !== undefined) updated.priority  = body.priority;
  if (body.deadline  !== undefined) updated.deadline  = body.deadline;
  if (body.archived  !== undefined) updated.archived  = body.archived;
  if (body.projectId !== undefined) updated.projectId = body.projectId;
  if (body.groupId   !== undefined) updated.groupId   = body.groupId;

  const updatedItems = [...existingItems];
  updatedItems[targetIndex] = updated;

  // Firestore に書き戻す（value フィールドのみ updateMask）
  try {
    await fsPatch(
      token,
      `users/${uid}/app_data/tasks`,
      { value: toFVal(updatedItems) },
      ["value"]
    );
  } catch (e) {
    return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 });
  }

  return Response.json({ ok: true, task: toTask(updated) });
}

// ─────────────────────────────────────────────
// GET /taskmaster/diag — 認証必須・変換サンプル付き
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
    const layout = await readLayout(token, uid);
    const allItems = layout === "v2"
      ? await queryTasks(token, uid, "completed", { booleanValue: false })
      : expandValue(await fsGet(token, `users/${uid}/app_data/tasks`));
    const active   = allItems.filter((t) => !bool(t.archived) && !bool(t.completed));
    const mapped   = active.slice(0, 5).map(toTask);

    result.tasks = {
      layout,
      total_in_array:   layout === "v2" ? null : allItems.length,
      active_count:     active.length,
      sample_converted: mapped,
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
// ─────────────────────────────────────────────
// POST /taskmaster/projects — プロジェクト新規作成
// v0.21.0 で追加（依頼書：de27238b-8526-4529-9e7c-a26667d506e4）
// ─────────────────────────────────────────────

type CreateProjectInput = {
  title: string;
  status?: string;
  endDate?: string | null;
};

export async function handleTaskmasterCreateProject(req: Request, env: Env): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "env not configured" }, { status: 500 });
  }

  let body: CreateProjectInput;
  try {
    body = await req.json() as CreateProjectInput;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  let token: string;
  try { token = await getFirestoreToken(env); }
  catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  // 既存プロジェクト配列を取得
  let projectsDoc: FSDoc;
  try {
    projectsDoc = await fsGet(token, `users/${uid}/app_data/projects`);
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const existingItems = expandValue(projectsDoc);

  // 新規プロジェクトオブジェクト
  const newProject: Item = {
    id:        crypto.randomUUID(),
    title:     body.title.trim(),
    status:    body.status ?? "active",
    endDate:   body.endDate ?? null,
    createdAt: new Date().toISOString().slice(0, 10),
  };

  const updatedItems = [...existingItems, newProject];

  try {
    await fsPatch(
      token,
      `users/${uid}/app_data/projects`,
      { value: toFVal(updatedItems) },
      ["value"]
    );
  } catch (e) {
    return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 });
  }

  return Response.json({ ok: true, project: toProject(newProject) }, { status: 201 });
}

// ─────────────────────────────────────────────
// POST /taskmaster/projects/delete — プロジェクト削除
// v0.21.0 で追加（依頼書：de27238b-8526-4529-9e7c-a26667d506e4）
// 配下タスクの projectId は null にリセット（カスケード削除なし）
// ─────────────────────────────────────────────

type DeleteProjectInput = {
  project_id: string;
};

export async function handleTaskmasterDeleteProject(req: Request, env: Env): Promise<Response> {
  const uid = env.NAOKI_UID;
  if (!uid || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    return Response.json({ error: "env not configured" }, { status: 500 });
  }

  let body: DeleteProjectInput;
  try {
    body = await req.json() as DeleteProjectInput;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.project_id || typeof body.project_id !== "string") {
    return Response.json({ error: "project_id is required" }, { status: 400 });
  }

  let token: string;
  try { token = await getFirestoreToken(env); }
  catch (e) {
    return Response.json({ error: "Firebase auth failed", detail: String(e) }, { status: 500 });
  }

  let layout: Layout;
  try { layout = await readLayout(token, uid); }
  catch (e) { return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 }); }
  if (layout === "migrating") return Response.json(MIGRATING, { status: 503 });

  // projects・tasks を並行取得
  let projectsDoc: FSDoc, tasksDoc: FSDoc | null = null, linked: Item[] = [];
  try {
    projectsDoc = await fsGet(token, `users/${uid}/app_data/projects`);
    if (layout === "v2") linked = await queryTasks(token, uid, "projectId", { stringValue: body.project_id });
    else tasksDoc = await fsGet(token, `users/${uid}/app_data/tasks`);
  } catch (e) {
    return Response.json({ error: "Firestore fetch failed", detail: String(e) }, { status: 500 });
  }

  const existingProjects = expandValue(projectsDoc);
  const targetIndex = existingProjects.findIndex((p) => p.id === body.project_id);
  if (targetIndex === -1) {
    return Response.json({ error: "project not found", project_id: body.project_id }, { status: 404 });
  }

  // プロジェクトを配列から除外
  const updatedProjects = existingProjects.filter((p) => p.id !== body.project_id);

  if (layout === "v2") {
    // 配下のタスクは 1 本ずつ projectId だけを空にする
    try {
      await fsPatch(token, `users/${uid}/app_data/projects`, { value: toFVal(updatedProjects) }, ["value"]);
      for (const t of linked) await patchTask(token, uid, String(t.id), { projectId: null });
    } catch (e) {
      return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 });
    }
    return Response.json({ ok: true, deleted: body.project_id, tasks_reset: linked.length });
  }

  // 配下タスクの projectId を null にリセット
  const existingTasks = expandValue(tasksDoc as FSDoc);
  const updatedTasks = existingTasks.map((t) =>
    t.projectId === body.project_id ? { ...t, projectId: null } : t
  );
  const resetCount = existingTasks.filter((t) => t.projectId === body.project_id).length;

  // projects・tasks を並行書き戻し
  try {
    await Promise.all([
      fsPatch(token, `users/${uid}/app_data/projects`, { value: toFVal(updatedProjects) }, ["value"]),
      fsPatch(token, `users/${uid}/app_data/tasks`,    { value: toFVal(updatedTasks) },    ["value"]),
    ]);
  } catch (e) {
    return Response.json({ error: "Firestore write failed", detail: String(e) }, { status: 500 });
  }

  return Response.json({ ok: true, deleted: body.project_id, tasks_reset: resetCount });
}
