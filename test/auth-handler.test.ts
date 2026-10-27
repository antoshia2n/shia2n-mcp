// v1.54.0：つなぐ（同意）の画面に Naoki 本人のログインを置いた。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthHandler, ownerUids, buildConsentHtml, redirectAllowed, freshSignIn } from "../src/auth-handler.js";

const NAOKI = "naoki-uid-123";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function makeEnv(over: Record<string, unknown> = {}) {
  const completed: unknown[] = [];
  const env: any = {
    MCP_DEFAULT_USER_ID: NAOKI,
    NAOKI_UID: NAOKI,
    OAUTH_PROVIDER: {
      async lookupClient(id: string) {
        if (id === "good") return { redirectUris: [REDIRECT], clientName: "Claude" };
        if (id === "phish") return { redirectUris: ["https://evil.example/cb"], clientName: "Claude" };
        return null;
      },
      async completeAuthorization(opts: unknown) { completed.push(opts); return { redirectTo: REDIRECT + "?code=abc" }; },
    },
    ...over,
  };
  return { env, completed };
}

const now = () => Math.floor(Date.now() / 1000);
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
// 札の形（ヘッダ.中身.署名）。署名の確かめは偽の verify が「sig-ok」で代わりにやる
const tk = (uid: string, authTime = now(), sig = "sig-ok") => `${b64u({ alg: "RS256" })}.${b64u({ sub: uid, auth_time: authTime })}.${sig}`;
const verify = async (t: string) => {
  const [, p, sig] = t.split(".");
  if (sig !== "sig-ok") return null;
  const sub = JSON.parse(Buffer.from(p, "base64url").toString()).sub;
  return { uid: sub, email: "x@example.com", emailVerified: true };
};

const handler = createAuthHandler(verify);

function post(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://shia2n-mcp.example/authorize", { method: "POST", body: fd });
}
const base = { client_id: "good", redirect_uri: REDIRECT, state: "s1", code_challenge: "cc", code_challenge_method: "S256", scope: "", approved: "true" };

test("持ち主の番号：NAOKI_UID と MCP_DEFAULT_USER_ID。どちらも無ければ空", () => {
  assert.deepEqual(ownerUids({ NAOKI_UID: "a", MCP_DEFAULT_USER_ID: "b" }), ["a", "b"]);
  assert.deepEqual(ownerUids({ MCP_DEFAULT_USER_ID: "b" }), ["b"]);
  assert.deepEqual(ownerUids({ NAOKI_UID: "", MCP_DEFAULT_USER_ID: "" }), []);
});

test("ログインの札が無いと、押してもつながらない（これまでは通っていた）", async () => {
  const { env, completed } = makeEnv();
  const res = await handler.fetch(post(base), env);
  assert.equal(res.status, 401);
  assert.equal(completed.length, 0);
});

test("偽の札・別の人の札ではつながらない", async () => {
  const { env, completed } = makeEnv();
  assert.equal((await handler.fetch(post({ ...base, id_token: tk(NAOKI, now(), "forged") }), env)).status, 401);
  assert.equal((await handler.fetch(post({ ...base, id_token: "not-a-token" }), env)).status, 401);
  assert.equal((await handler.fetch(post({ ...base, id_token: tk("someone-else") }), env)).status, 403);
  assert.equal(completed.length, 0);
});

test("Naoki 本人の札ならつながり、付ける番号は MCP_DEFAULT_USER_ID", async () => {
  const { env, completed } = makeEnv();
  const res = await handler.fetch(post({ ...base, id_token: tk(NAOKI) }), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), REDIRECT + "?code=abc");
  assert.equal(completed.length, 1);
  assert.equal((completed[0] as any).userId, NAOKI);
  assert.equal((completed[0] as any).metadata.login, "firebase");
});

test("Naoki 本人の札でも、ログインから 10 分を超えた札（ほかのアプリで取った札の流し込み）は断る", async () => {
  const { env, completed } = makeEnv();
  const res = await handler.fetch(post({ ...base, id_token: tk(NAOKI, now() - 3600) }), env);
  assert.equal(res.status, 401);
  assert.equal(completed.length, 0);
  assert.equal(freshSignIn(tk(NAOKI, now() - 30)), true);
  assert.equal(freshSignIn(tk(NAOKI, now() - 601)), false);
  assert.equal(freshSignIn(`${b64u({})}.${b64u({ sub: NAOKI })}.x`), false);
});

test("名前を Claude と偽っても、戻り先が決まった住所でなければ画面も出さず、つなげない", async () => {
  const { env, completed } = makeEnv();
  const g = await handler.fetch(new Request(`https://x/authorize?client_id=phish&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=cc`), env);
  assert.equal(g.status, 400);
  assert.ok((await g.text()).includes("evil.example"));
  const p = await handler.fetch(post({ ...base, client_id: "phish", redirect_uri: "https://evil.example/cb", id_token: tk(NAOKI) }), env);
  assert.equal(p.status, 400);
  assert.equal(completed.length, 0);
});

test("戻り先の決まり：claude.ai・chatgpt.com は https だけ、localhost は http も可、足すのは設定で", () => {
  const e = {};
  assert.equal(redirectAllowed(e, "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed(e, "https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(redirectAllowed(e, "http://claude.ai/cb"), false);
  assert.equal(redirectAllowed(e, "http://localhost:6274/callback"), true);
  assert.equal(redirectAllowed(e, "https://claude.ai.evil.example/cb"), false);
  assert.equal(redirectAllowed(e, "https://user:pw@claude.ai/cb"), false);
  assert.equal(redirectAllowed(e, "javascript:alert(1)"), false);
  assert.equal(redirectAllowed({ MCP_ALLOWED_REDIRECT_HOSTS: "x.example, y.example" }, "https://y.example/cb"), true);
});

test("本人の番号の設定が無いときは、誰もつなげない形で止まる", async () => {
  const { env, completed } = makeEnv({ NAOKI_UID: "", MCP_DEFAULT_USER_ID: "" });
  const res = await handler.fetch(post({ ...base, id_token: tk(NAOKI) }), env);
  assert.equal(res.status, 503);
  assert.equal(completed.length, 0);
});

test("登録されていないつなぎ先・登録と違う戻り先は、画面も出さず、断りの飛び先にも使わない", async () => {
  const { env, completed } = makeEnv();
  const g1 = await handler.fetch(new Request(`https://x/authorize?client_id=evil&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=cc`), env);
  assert.equal(g1.status, 400);
  const g2 = await handler.fetch(new Request(`https://x/authorize?client_id=good&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=cc`), env);
  assert.equal(g2.status, 400);
  const d = await handler.fetch(post({ ...base, redirect_uri: "https://evil.example/cb", approved: "false" }), env);
  assert.equal(d.status, 400);
  assert.equal(d.headers.get("Location"), null);
  assert.equal(completed.length, 0);
});

test("つながないを押すと、登録どおりの戻り先へ access_denied で戻る（札は要らない）", async () => {
  const { env, completed } = makeEnv();
  const res = await handler.fetch(post({ ...base, approved: "false" }), env);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("Location")!);
  assert.equal(loc.searchParams.get("error"), "access_denied");
  assert.equal(loc.searchParams.get("state"), "s1");
  assert.equal(completed.length, 0);
});

test("同意の画面：ログインの部品があり、枠に埋め込ませない・値は逃がしてある", async () => {
  const { env } = makeEnv();
  const res = await handler.fetch(new Request(`https://x/authorize?client_id=good&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=cc&state=${encodeURIComponent('"><script>x</script>')}`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  const html = await res.text();
  assert.ok(html.includes("firebase-auth-compat.js"));
  assert.ok(html.includes('name="id_token"'));
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("Claude"));
  assert.ok(html.includes("戻る先：<b>claude.ai</b>"));
});

test("対照：画面の文には「Naoki 本人の Google でログインしたときだけ」が入る", () => {
  const html = buildConsentHtml({ clientId: "c", clientName: "", redirectUri: REDIRECT, state: "", codeChallenge: "cc", codeChallengeMethod: "S256", scope: "" });
  assert.ok(html.includes("Naoki 本人の Google でログインしたときだけ"));
  assert.ok(html.includes("つなぎ先の名乗り：c"));
});
