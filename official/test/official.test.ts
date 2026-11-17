// 外向けの窓口の試験。走らせ方：official/ で npm test（esbuild で束ねてから node --test）
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { allowedToolNames, canConnect, type Rights } from "../src/rights.js";
import { buildServer } from "../src/server.js";
import { OFFICIAL_TOOL_NAMES } from "../src/tools.js";
import { createAuthHandler, freshSignIn } from "../src/auth.js";

const MEMBER = "327ce031-0a0c-4b5b-9cb2-38e62f506fab";
const NAOKI_ONLY = ["okane__", "sales_manager__", "members__", "rumin_doc__"];
const ok = (keys: string[], targets: string[]): Extract<Rights, { ok: true }> => ({ ok: true, member_id: MEMBER, keys, targets });

async function listAndCall(rightsAtList: Extract<Rights, { ok: true }>, rightsAtCall: Rights = rightsAtList) {
  const gate = { rights: async () => rightsAtCall };
  const server = buildServer(gate, MEMBER, rightsAtList);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  return { client, names };
}

test("名簿に Naoki 用の道具は 1 本も無い", () => {
  for (const n of OFFICIAL_TOOL_NAMES) for (const p of NAOKI_ONLY) assert.ok(!n.startsWith(p), n);
});

test("mcp_official が無ければ、つなげず、道具も 0 本", () => {
  assert.equal(canConnect(["portal", "manabu"]), false);
  assert.deepEqual(allowedToolNames(OFFICIAL_TOOL_NAMES, ["mcp-official__my_rights"]), []);
});

test("表に Naoki 用の道具の名前を書いても、名簿に無いので出ない", () => {
  const t = ["mcp_official", "mcp-okane__list_plans", "mcp-sales_manager__list_payments", "mcp-members__search", "mcp-rumin_doc__replace_text"];
  assert.deepEqual(allowedToolNames(OFFICIAL_TOOL_NAMES, t), []);
});

test("生徒（mcp_official だけ）：一覧は空", async () => {
  const { names } = await listAndCall(ok(["shiarabo_basic"], ["manabu", "mcp_official", "portal"]));
  assert.deepEqual(names, []);
});

test("権利に mcp-道具 がある人にだけ、その道具が見える", async () => {
  const { names } = await listAndCall(ok(["guest"], ["mcp_official", "mcp-official__my_rights", "mcp-okane__list_plans"]));
  assert.deepEqual(names, ["official__my_rights"]);
});

test("道具を使うときにも権利を取り直す（使う前に外れたら断る）", async () => {
  const listed = ok(["guest"], ["mcp_official", "mcp-official__my_rights"]);
  const { client } = await listAndCall(listed, ok([], []));
  const r = await client.callTool({ name: "official__my_rights", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.content), /権利がありません/);
});

test("使えるときは自分の権利だけを返す", async () => {
  const listed = ok(["guest"], ["mcp_official", "mcp-official__my_rights"]);
  const { client } = await listAndCall(listed);
  const r = await client.callTool({ name: "official__my_rights", arguments: {} });
  assert.notEqual(r.isError, true);
  const body = JSON.parse((r.content as { text: string }[])[0].text);
  assert.deepEqual(body, { ok: true, 権利: ["guest"], 使える道具: ["official__my_rights"] });
});

// ───────── つなぐ画面 ─────────

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const now = () => Math.floor(Date.now() / 1000);
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tk = (authTime = now()) => `${b64u({ alg: "RS256" })}.${b64u({ sub: "u1", auth_time: authTime })}.sig`;

function makeEnv(login: Rights) {
  const completed: any[] = [];
  const env: any = {
    GATE: { login: async () => login },
    OAUTH_PROVIDER: {
      async lookupClient(id: string) { return id === "good" ? { redirectUris: [REDIRECT], clientName: "Claude" } : null; },
      async completeAuthorization(opts: unknown) { completed.push(opts); return { redirectTo: REDIRECT + "?code=abc" }; },
    },
  };
  return { env, completed };
}

function post(token: string) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ client_id: "good", redirect_uri: REDIRECT, state: "s", code_challenge: "c", code_challenge_method: "S256", scope: "", approved: "true", id_token: token })) f.set(k, v);
  return new Request("https://x/authorize", { method: "POST", body: f });
}

test("権利に mcp_official がある会員はつなげ、札には番号だけが入る", async () => {
  const { env, completed } = makeEnv(ok(["shiarabo_basic"], ["mcp_official"]));
  const res = await createAuthHandler().fetch(post(tk()), env);
  assert.equal(res.status, 302);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].userId, MEMBER);
  assert.deepEqual(completed[0].props, { memberId: MEMBER });
});

test("mcp_official が無い会員はつなげない", async () => {
  const { env, completed } = makeEnv(ok(["shiarabo_trial"], ["portal"]));
  const res = await createAuthHandler().fetch(post(tk()), env);
  assert.equal(res.status, 403);
  assert.equal(completed.length, 0);
});

test("台帳にいない人はつなげない", async () => {
  const { env, completed } = makeEnv({ ok: false, reason: "not_found" });
  const res = await createAuthHandler().fetch(post(tk()), env);
  assert.equal(res.status, 403);
  assert.equal(completed.length, 0);
});

test("古いログインの札は受けない", async () => {
  const { env, completed } = makeEnv(ok(["guest"], ["mcp_official"]));
  const res = await createAuthHandler().fetch(post(tk(now() - 3600)), env);
  assert.equal(res.status, 401);
  assert.equal(completed.length, 0);
  assert.equal(freshSignIn(tk(now() - 60)), true);
});

test("名簿の道具の名前は、表の target の決まり（^[a-z0-9_-]{2,40}$）に収まる", () => {
  for (const n of OFFICIAL_TOOL_NAMES) assert.match("mcp-" + n, /^[a-z0-9_-]{2,40}$/, n);
});
