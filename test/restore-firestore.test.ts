// Firestore の利用者の戻す試し（src/restore-firestore.ts）。esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { restoreFirestoreUsers, docId, TEST_COLLECTION } from "../src/restore-firestore.js";

function fakeFirestore() {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const m = init.method ?? "GET";
    calls.push(`${m} ${url}`);
    const path = url.replace("https://fs.test/", "").split("?")[0];
    if (m === "GET" && path === TEST_COLLECTION) {
      return new Response(JSON.stringify({ documents: [...store.keys()].map((id) => ({ name: `x/documents/${TEST_COLLECTION}/${id}` })) }), { status: 200 });
    }
    const id = decodeURIComponent(path.split("/")[1] ?? "");
    if (m === "PATCH") { store.set(id, JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }
    if (m === "DELETE") { store.delete(id); return new Response("{}", { status: 200 }); }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { store, calls, f };
}
const envWith = (body: unknown) => ({ BACKUP_BUCKET: { get: async () => body === null ? null : { text: async () => JSON.stringify(body) } } }) as any;

test("文書の名前から利用者の番号を取る。users 以外・形の違うものは null", () => {
  assert.equal(docId("projects/p/databases/d/documents/users/abc_123"), "abc_123");
  assert.equal(docId("projects/p/databases/d/documents/apps/abc"), null);
  assert.equal(docId("projects/p/databases/d/documents/users/a b"), null);
});

test("控えの 3 件を試しの置き場へ戻して数え、数えたら消す。本番の users には書かない", async () => {
  const fs = fakeFirestore();
  const docs = ["u1", "u2", "u3"].map((id) => ({ name: `projects/p/databases/d/documents/users/${id}`, fields: { role: { stringValue: "member" } } }));
  const out = await restoreFirestoreUsers({ env: envWith({ collection: "users", documents: docs }), table: "users", date: "2026-10-29", getToken: async () => "t", fetchFn: fs.f, base: "https://fs.test" });
  assert.equal(out.控えの件数, 3);
  assert.equal(out.書き戻した件数, 3);
  assert.equal(out.戻したあとの件数, 3);
  assert.equal(out.件数が一致したか, true);
  assert.equal(out.試しの置き場を消した, true);
  assert.equal(fs.store.size, 0);
  assert.ok(fs.calls.every((c) => !/\/users(\/|\?|$)/.test(c.replace(TEST_COLLECTION, ""))), "本番の users に触っていない");
});

test("止める：users 以外・控えが無い", async () => {
  const fs = fakeFirestore();
  assert.equal((await restoreFirestoreUsers({ env: envWith({}), table: "apps", date: "d", getToken: async () => "t", fetchFn: fs.f, base: "https://fs.test" })).結果, "止めた");
  assert.equal((await restoreFirestoreUsers({ env: envWith(null), table: "users", date: "d", getToken: async () => "t", fetchFn: fs.f, base: "https://fs.test" })).結果, "止めた");
});
