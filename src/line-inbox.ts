/**
 * shia2n-mcp / src/line-inbox.ts / 新設（2026-10-14 v1.16.0 開発部）
 * LINE タスク秘書：Naoki と Bot だけの「秘書グループ」に転送された発言や画面の写真から、
 * Workers AI がタスクの候補を最大 5 件取り出し、カードの「登録」を押した分だけ TaskMaster に入れる。
 * 依頼：https://www.notion.so/3f99c6c1c43981c0ae9ed73743991834（taskmaster PR #9 の作り直し）
 *
 *   受け口：POST /line/webhook（LINE の署名で守る。LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN が無ければ 503）
 *   置き場（Firestore・users/{NAOKI_UID} の下）：
 *     line_inbox/owner             結んだグループと Naoki の LINE の番号（1 件）
 *     line_inbox_pairing/{6 桁}     結ぶ番号（10 分）
 *     line_inbox_candidates/{li_…} 候補（原文は持たない・7 日で消す）
 *     line_inbox_events/{evt_…}    同じ受け取りを 2 度処理しないための印（2 日で消す）
 *   返事はすべて reply（LINE の決まりで通数に数えない）。reply が失敗したときだけ push を 1 通
 *   タスクの書き込みは taskmaster__add_task と同じ形（buildNewTask / newTaskDocFields）
 */
import type { Env } from "./index.js";
import {
  FIRESTORE_BASE, getFirestoreToken, fsGetOrNull, fromVal, toFVal, readLayout, queryTasks,
  buildNewTask, newTaskDocFields, type FSDoc, type FVal,
} from "./taskmaster.js";
import {
  validSignature, decide, pairCode, parseAction, projectOptions, parseAiJson, cleanTasks, systemPrompt,
  TASKS_SCHEMA, similarTitle, cardsMessage, projectPicker, HELP, taskNotes, jstToday, sha32,
  CANDIDATE_DAYS, EVENT_DAYS, PAIR_MINUTES,
  type Obj, type Owner, type ProjectOption, type CardItem,
} from "./line-inbox-core.js";

export const LINE_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const AI_TIMEOUT_MS = 18000;
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 4000;
const MAX_IMAGE = 5 * 1024 * 1024;
const LINE_API = "https://api.line.me/v2/bot";

type Doc = FSDoc & { updateTime?: string };
type Write = Obj;

const DOC_ROOT = FIRESTORE_BASE.replace("https://firestore.googleapis.com/v1/", "");
const p = {
  owner: (uid: string) => `users/${uid}/line_inbox/owner`,
  pairing: (uid: string, code: string) => `users/${uid}/line_inbox_pairing/${code}`,
  candidate: (uid: string, id: string) => `users/${uid}/line_inbox_candidates/${id}`,
  event: (uid: string, id: string) => `users/${uid}/line_inbox_events/${id}`,
  task: (uid: string, id: string) => `users/${uid}/tm_tasks/${encodeURIComponent(id)}`,
};
const fullName = (path: string) => `${DOC_ROOT}/${path}`;
const fieldsOf = (o: Obj): Record<string, FVal> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toFVal(v)]));
const read = (d: Doc | null): Obj => {
  const out: Obj = {};
  for (const [k, v] of Object.entries(d?.fields ?? {})) out[k] = fromVal(v);
  return out;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ── Firestore ──
/** 1 回の commit（全部入るか、何も入らないか）。前提が崩れていたら "conflict" */
async function commit(token: string, writes: Write[]): Promise<"ok" | "conflict"> {
  const res = await fetch(`${FIRESTORE_BASE}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (res.ok) return "ok";
  const body = await res.json().catch(() => ({})) as { error?: { status?: string } };
  if (["FAILED_PRECONDITION", "ALREADY_EXISTS", "ABORTED", "NOT_FOUND"].includes(body.error?.status ?? "")) return "conflict";
  throw new Error(`Firestore commit failed: ${res.status} ${body.error?.status ?? ""}`);
}
const createW = (path: string, data: Obj): Write => ({ update: { name: fullName(path), fields: fieldsOf(data) }, currentDocument: { exists: false } });
const updateW = (doc: Doc, data: Obj): Write => ({
  update: { name: doc.name, fields: fieldsOf(data) }, updateMask: { fieldPaths: Object.keys(data) },
  currentDocument: doc.updateTime ? { updateTime: doc.updateTime } : { exists: true },
});
const deleteW = (name: string): Write => ({ delete: name });

async function getDoc(token: string, path: string): Promise<Doc | null> {
  return await fsGetOrNull(token, path) as Doc | null;
}

async function readValue(token: string, uid: string, key: string): Promise<unknown> {
  const d = await fsGetOrNull(token, `users/${uid}/app_data/${key}`);
  return d?.fields?.value ? fromVal(d.fields.value as FVal) : null;
}

async function readOwner(token: string, uid: string): Promise<(Owner & { pairedAt: string }) | null> {
  const o = read(await getDoc(token, p.owner(uid)));
  return str(o.groupId) && str(o.userId) ? { groupId: str(o.groupId), userId: str(o.userId), pairedAt: str(o.pairedAt) } : null;
}

async function loadOptions(token: string, uid: string): Promise<ProjectOption[]> {
  const [initiatives, projects] = await Promise.all([readValue(token, uid, "os_initiatives_v1"), readValue(token, uid, "projects")]);
  return projectOptions(initiatives, projects);
}

/** 同じプロジェクトの未完了のタスクの題名（似たタスクの照らし合わせ用） */
async function openTitles(token: string, uid: string, projectId: string): Promise<string[]> {
  const rows = await queryTasks(token, uid, "projectId", { stringValue: projectId });
  return rows.filter(t => t.completed !== true && t.archived !== true).map(t => str(t.title)).filter(Boolean);
}

/** 日時の欄が cutoff より前の文書を消す（1 回 300 件まで） */
async function deleteOlder(token: string, uid: string, collection: string, field: string, cutoff: string): Promise<number> {
  const res = await fetch(`${FIRESTORE_BASE}/users/${uid}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "LESS_THAN", value: { stringValue: cutoff } } },
      select: { fields: [{ fieldPath: field }] },
      limit: 300,
    } }),
  });
  if (!res.ok) throw new Error(`Firestore runQuery ${collection} failed: ${res.status}`);
  const names = ((await res.json()) as { document?: { name: string } }[]).map(r => r.document?.name).filter((n): n is string => !!n);
  if (names.length) await commit(token, names.map(deleteW));
  return names.length;
}

// ── LINE ──
async function lineFetch(env: Env, path: string, body: unknown): Promise<Response> {
  return await fetch(`${LINE_API}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** reply で返す。印の期限切れなどで失敗したら、グループへ push を 1 通だけ送る */
async function answer(env: Env, replyToken: string, groupId: string, messages: Obj[]): Promise<void> {
  const r = await lineFetch(env, "message/reply", { replyToken, messages });
  if (r.ok) return;
  console.error("[line_inbox] reply failed", r.status);
  const q = await lineFetch(env, "message/push", { to: groupId, messages });
  if (!q.ok) console.error("[line_inbox] push failed", q.status);
}
const text = (t: string): Obj => ({ type: "text", text: t.slice(0, 1900) });

async function leave(env: Env, target: "group" | "room", id: string): Promise<void> {
  const r = await lineFetch(env, `${target}/${encodeURIComponent(id)}/leave`, undefined);
  console.log("[line_inbox] left", target, r.status);
}

async function imageDataUrl(env: Env, messageId: string): Promise<string> {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`image ${r.status}`);
  const mime = (r.headers.get("content-type") ?? "").split(";")[0];
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("unsupported image");
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error("image too large");
  let s = "";
  for (let i = 0; i < buf.length; i += 4096) s += String.fromCharCode(...buf.subarray(i, i + 4096));
  return `data:${mime};base64,${btoa(s)}`;
}

// ── AI（Workers AI。Claude API・OpenAI は使わない）──
class Timeout extends Error {}
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Timeout("timeout")), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

async function extract(env: Env, options: ProjectOption[], input: { text?: string; image?: string }) {
  if (!env.AI) throw new Error("Workers AI の結び（AI）がありません");
  const user = input.image
    ? [{ type: "text", text: "資料は画面の写真です。写っている発言から取り出してください。" }, { type: "image_url", image_url: { url: input.image } }]
    : "資料：\n" + (input.text ?? "");
  const ai = env.AI;
  const base = {
    messages: [{ role: "system", content: systemPrompt(jstToday(), options) }, { role: "user", content: user }],
    max_tokens: 1200,
    temperature: 0.2,
  };
  const started = Date.now();
  let out: unknown;
  try {
    // 答えの形を JSON の型で縛る（guided_json）
    out = await withTimeout(ai.run(LINE_AI_MODEL, { ...base, guided_json: TASKS_SCHEMA }), AI_TIMEOUT_MS);
  } catch (err) {
    // 型の縛りで断られたときだけ、時間が残っていれば縛りなしでもう 1 回（答えは cleanTasks で確かめる）
    const left = AI_TIMEOUT_MS - (Date.now() - started);
    if (err instanceof Timeout || left < 8000) throw err;
    console.error("[line_inbox] guided_json failed, retry without", String(err));
    out = await withTimeout(ai.run(LINE_AI_MODEL, base), left);
  }
  return cleanTasks(parseAiJson((out as { response?: unknown })?.response ?? out), options);
}

// ── 受け口 ──
export async function handleLineWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN || !env.NAOKI_UID) {
    return new Response("not configured", { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });
  if (!await validSignature(raw, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  let events: Obj[];
  try {
    const body = JSON.parse(raw) as { events?: unknown };
    if (!Array.isArray(body.events)) return new Response("bad events", { status: 400 });
    events = (body.events as Obj[]).slice(0, 20);
  } catch { return new Response("bad json", { status: 400 }); }
  if (events.length) {
    // LINE へはすぐ 200 を返し、処理は返したあとに回す（Cloudflare の決まりで 30 秒まで）
    ctx.waitUntil((async () => {
      const uid = env.NAOKI_UID as string;
      const token = await getFirestoreToken(env);
      const owner = await readOwner(token, uid);
      await Promise.all(events.map(e => handleEvent(env, token, uid, owner, e).catch(err => console.error("[line_inbox] event", String(err)))));
    })().catch(err => console.error("[line_inbox] webhook", String(err))));
  }
  return new Response("ok");
}

async function handleEvent(env: Env, token: string, uid: string, owner: Owner | null, event: Obj): Promise<void> {
  const d = decide(event, owner);
  if (d.kind === "ignore") return;
  if (d.kind === "leave") return await leave(env, d.target, d.id);
  if (d.kind === "unpaired_hint") {
    await lineFetch(env, "message/reply", { replyToken: d.replyToken, messages: [text("このグループを秘書グループにするには「/connect」と送ってください。")] });
    return;
  }
  if (d.kind === "pair_request") {
    const code = pairCode();
    const now = Date.now();
    const r = await commit(token, [createW(p.pairing(uid, code), {
      groupId: d.groupId, userId: d.userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PAIR_MINUTES * 60000).toISOString(),
    })]);
    if (r !== "ok") {
      await lineFetch(env, "message/reply", { replyToken: d.replyToken, messages: [text("番号を作れませんでした。もう一度「/connect」と送ってください。")] });
      return;
    }
    await lineFetch(env, "message/reply", { replyToken: d.replyToken, messages: [text(`結ぶ番号：${code}（${PAIR_MINUTES} 分有効）\nこの番号を Claude に伝えてください。`)] });
    return;
  }
  // ここから先は「結んだグループ」かつ「Naoki の番号」のときだけ
  const say = (messages: Obj[]) => answer(env, d.replyToken, d.groupId, messages);
  if (event.type === "postback") return await handleAction(env, token, uid, d.groupId, (event.postback as Obj | undefined)?.data, say);
  const msg = (event.message ?? {}) as Obj;
  const t = str(msg.text);
  if (msg.type === "text" && t === "/disconnect") {
    const o = await getDoc(token, p.owner(uid));
    if (o) await commit(token, [deleteW(o.name)]);
    await say([text("結ぶのをやめました。このグループから退出します。")]);
    await leave(env, "group", d.groupId);
    return;
  }
  if (msg.type === "text" && (t === "/help" || t === "/connect")) return await say([text(t === "/connect" ? "このグループは結んであります。\n" + HELP : HELP)]);
  if (msg.type !== "text" && msg.type !== "image") return await say([text("文章か画面の写真を送ってください。")]);
  if (msg.type === "text" && (!t || t.length > MAX_TEXT)) return await say([text(`${MAX_TEXT} 文字以内に分けて送ってください。`)]);

  // 同じ受け取りを 2 度処理しない（LINE の再送に備える）
  const eventId = "evt_" + await sha32(str(event.webhookEventId) || str(msg.id));
  if (await commit(token, [createW(p.event(uid, eventId), { createdAt: new Date().toISOString() })]) === "conflict") return;

  const options = await loadOptions(token, uid);
  if (!options.length) return await say([text("登録先のプロジェクトが読めませんでした（haAku の取り組みに結んだプロジェクトが 0 件）。")]);
  let tasks;
  try {
    tasks = await extract(env, options, msg.type === "image" ? { image: await imageDataUrl(env, str(msg.id)) } : { text: t });
  } catch (err) {
    console.error("[line_inbox] extract", String(err));
    return await say([text(err instanceof Timeout
      ? "時間内に読み終わりませんでした。短く分けて、もう一度送ってください。"
      : "読み取りに失敗しました。もう一度送ってください。")]);
  }
  if (!tasks.length) return await say([text("自分がやる作業は見つかりませんでした。")]);

  const titles = new Map<string, string[]>();
  for (const pid of new Set(tasks.map(x => x.projectId).filter((x): x is string => !!x))) {
    titles.set(pid, await openTitles(token, uid, pid).catch(() => []));
  }
  const now = Date.now();
  const opts = options.map(o => ({ id: o.id, name: o.name }));
  const items: CardItem[] = [];
  const writes: Write[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const x = tasks[i];
    const id = "li_" + await sha32(eventId + ":" + i);
    const projectName = options.find(o => o.id === x.projectId)?.name ?? null;
    const similar = x.projectId ? similarTitle(x.title, titles.get(x.projectId) ?? []) : null;
    writes.push(createW(p.candidate(uid, id), {
      id, title: x.title, deadline: x.deadline, priority: x.priority, notes: x.notes, projectId: x.projectId,
      options: opts, similar, status: "pending", groupId: d.groupId, userId: d.userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + CANDIDATE_DAYS * 86400000).toISOString(),
    }));
    items.push({ id, title: x.title, deadline: x.deadline, priority: x.priority, notes: x.notes, projectName, similar });
  }
  if (await commit(token, writes) === "conflict") return;
  await say([cardsMessage(items)]);
}

async function handleAction(env: Env, token: string, uid: string, groupId: string, data: unknown, say: (m: Obj[]) => Promise<void>): Promise<void> {
  const a = parseAction(data);
  if (!a) return;
  const doc = await getDoc(token, p.candidate(uid, a.id));
  if (!doc) return await say([text("候補が見つかりません（候補は 7 日で消えます）。")]);
  const c = read(doc);
  if (str(c.groupId) !== groupId) return;
  if (c.status !== "pending") return await say([text("この候補は処理済みです。")]);
  if (Date.parse(str(c.expiresAt)) < Date.now()) return await say([text("7 日を過ぎた候補です。もう一度送ってください。")]);
  const options = (Array.isArray(c.options) ? c.options as Obj[] : []).map(o => ({ id: str(o.id), name: str(o.name), hint: "" }));
  const title = str(c.title);

  if (a.a === "drop") {
    const r = await commit(token, [updateW(doc, { status: "discarded", resolvedAt: new Date().toISOString() })]);
    return await say([text(r === "ok" ? `破棄しました：${title}` : "他の操作と重なりました。もう一度押してください。")]);
  }
  if (a.a === "proj") return await say([projectPicker(a.id, options)]);
  if (a.a === "setp") {
    const opt = options[a.p];
    if (!opt) return;
    const similar = similarTitle(title, await openTitles(token, uid, opt.id).catch(() => []));
    const r = await commit(token, [updateW(doc, { projectId: opt.id, similar })]);
    if (r !== "ok") return await say([text("他の操作と重なりました。もう一度押してください。")]);
    return await say([cardsMessage([{
      id: a.id, title, deadline: str(c.deadline) || null, priority: str(c.priority), notes: str(c.notes), projectName: opt.name, similar,
    }])]);
  }
  // save
  const projectId = str(c.projectId);
  if (!projectId) return await say([projectPicker(a.id, options)]);
  if (await readLayout(token, uid) !== "v2") return await say([text("TaskMaster の置き場が新しい形ではないため、登録を止めました。")]);
  const task = buildNewTask({ title, priority: str(c.priority) || "medium", deadline: str(c.deadline) || null, projectId });
  const r = await commit(token, [
    updateW(doc, { status: "saved", taskId: task.id, resolvedAt: new Date().toISOString() }),
    createW(p.task(uid, task.id as string), newTaskDocFields(task, taskNotes(str(c.notes)))),
  ]);
  const name = options.find(o => o.id === projectId)?.name ?? "";
  await say([text(r === "ok" ? `TaskMaster に入れました：${title}（${name}）` : "他の操作と重なりました。TaskMaster を確かめてください。")]);
}

// ── 毎日の後片付け（候補 7 日・受け取りの印 2 日・結ぶ番号は期限切れ）──
export async function cleanupLineInbox(env: Env): Promise<{ count: number; detail: string }> {
  if (!env.NAOKI_UID) throw new Error("NAOKI_UID がありません");
  const uid = env.NAOKI_UID;
  const token = await getFirestoreToken(env);
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const cand = await deleteOlder(token, uid, "line_inbox_candidates", "createdAt", iso(now - CANDIDATE_DAYS * 86400000));
  const evt = await deleteOlder(token, uid, "line_inbox_events", "createdAt", iso(now - EVENT_DAYS * 86400000));
  const pair = await deleteOlder(token, uid, "line_inbox_pairing", "expiresAt", iso(now));
  return { count: cand + evt + pair, detail: `候補 ${cand}・受け取りの印 ${evt}・結ぶ番号 ${pair} を消した` };
}

// ── Claude から呼ぶ（道具）──
const tail = (s: string) => (s ? "…" + s.slice(-4) : "");

export async function pairLineInbox(env: Env, code: string): Promise<Obj> {
  if (!/^\d{6}$/.test(code)) throw new Error("番号は 6 桁の数字で渡してください");
  if (!env.NAOKI_UID) throw new Error("NAOKI_UID がありません");
  const uid = env.NAOKI_UID;
  const token = await getFirestoreToken(env);
  if (await readOwner(token, uid)) throw new Error("すでに結んであります。先に line_inbox__unpair で外してください");
  const doc = await getDoc(token, p.pairing(uid, code));
  const pr = read(doc);
  if (!doc || !str(pr.groupId) || !str(pr.userId)) throw new Error("その番号は見つかりません。秘書グループで「/connect」と送り直してください");
  if (Date.parse(str(pr.expiresAt)) < Date.now()) throw new Error("番号の期限（10 分）が切れました。秘書グループで「/connect」と送り直してください");
  const r = await commit(token, [
    createW(p.owner(uid), { groupId: str(pr.groupId), userId: str(pr.userId), pairedAt: new Date().toISOString() }),
    deleteW(doc.name),
  ]);
  if (r !== "ok") throw new Error("ほかの操作と重なりました。もう一度呼んでください");
  return { ok: true, paired: true, group: tail(str(pr.groupId)), user: tail(str(pr.userId)) };
}

export async function unpairLineInbox(env: Env): Promise<Obj> {
  if (!env.NAOKI_UID) throw new Error("NAOKI_UID がありません");
  const uid = env.NAOKI_UID;
  const token = await getFirestoreToken(env);
  const doc = await getDoc(token, p.owner(uid));
  if (!doc) return { ok: true, paired: false, note: "結んでいませんでした" };
  const o = read(doc);
  await commit(token, [deleteW(doc.name)]);
  let left = false;
  if (env.LINE_CHANNEL_ACCESS_TOKEN && str(o.groupId)) {
    const r = await lineFetch(env, `group/${encodeURIComponent(str(o.groupId))}/leave`, undefined);
    left = r.ok;
  }
  return { ok: true, paired: false, left_group: left };
}

export async function lineInboxStatus(env: Env): Promise<Obj> {
  const configured = !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!env.NAOKI_UID) throw new Error("NAOKI_UID がありません");
  const uid = env.NAOKI_UID;
  const token = await getFirestoreToken(env);
  const [owner, options] = await Promise.all([readOwner(token, uid), loadOptions(token, uid)]);
  return {
    ok: true, configured, ai_binding: !!env.AI, model: LINE_AI_MODEL,
    paired: !!owner, paired_at: owner?.pairedAt ?? null, group: owner ? tail(owner.groupId) : null,
    projects: options.map(o => o.name),
    note: configured ? "受け口は https://shia2n-mcp.gameister1.workers.dev/line/webhook" : "LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN が入るまで受け口は 503 を返す（眠った状態）",
  };
}
