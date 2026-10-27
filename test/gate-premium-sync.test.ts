// 作業 49：esbuild で束ねてから node --test。通信はすべて fetch の差し替えで閉じる。
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { syncPortalPremium } from "../src/gate.js";
import { FIRESTORE_BASE } from "../src/taskmaster.js";
import type { Env } from "../src/index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
  FIREBASE_SA_EMAIL: "test@example.invalid",
  FIREBASE_SA_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
} as Env;
const profileUrl = FIRESTORE_BASE + "/users/test-uid";
const subscriptionUrl = "https://supabase.test/rest/v1/member_subscription?select=id&member_id=eq.test-member&plan=eq.premium&status=eq.active&limit=1";

const cases = [
  { name: "プレミアムでない → not_premium・PATCH 0 回", premium: false, expected: "not_premium", calls: 1 },
  { name: "文書が無い → no_profile・PATCH 0 回", missing: true, expected: "no_profile", calls: 3 },
  { name: "role が admin → already・PATCH 0 回", role: "admin", expected: "already", calls: 3 },
  { name: "paymentStatus が monitor → already・PATCH 0 回", status: "monitor", expected: "already", calls: 3 },
  { name: "basic のプレミアム契約者 → synced・PATCH 1 回・mask は 2 つだけ", expected: "synced", calls: 4 },
  { name: "Supabase が 500 → error・例外なし", sbError: true, expected: "error", calls: 1 },
];

for (const scenario of cases) {
  test(scenario.name, async (t) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === subscriptionUrl) {
        assert.equal(init?.method ?? "GET", "GET");
        return scenario.sbError
          ? new Response("failure", { status: 500 })
          : Response.json(scenario.premium === false ? [] : [{ id: "subscription" }]);
      }
      if (url === "https://oauth2.googleapis.com/token") {
        assert.equal(init?.method, "POST");
        return Response.json({ access_token: "test-token" });
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
      if (url === profileUrl && (init?.method ?? "GET") === "GET") {
        if (scenario.missing) return new Response("", { status: 404 });
        return Response.json({ fields: {
          role: { stringValue: scenario.role ?? "member" },
          paymentStatus: { stringValue: scenario.status ?? "basic" },
          allowedApps: { arrayValue: { values: [{ stringValue: "existing-app" }] } },
        } });
      }
      if (url.startsWith(profileUrl + "?") && init?.method === "PATCH") {
        return Response.json({});
      }
      throw new Error("Unexpected fetch: " + url);
    });

    let result: string | undefined;
    await assert.doesNotReject(async () => {
      result = await syncPortalPremium(env, "test-uid", "test-member");
    });
    assert.equal(result, scenario.expected);
    assert.equal(calls.length, scenario.calls);
    const patches = calls.filter(c => c.init?.method === "PATCH");
    assert.equal(patches.length, scenario.expected === "synced" ? 1 : 0);
    if (patches.length) {
      const patch = patches[0];
      const url = new URL(patch.url);
      assert.deepEqual([...url.searchParams], [
        ["updateMask.fieldPaths", "paymentStatus"],
        ["updateMask.fieldPaths", "updatedAt"],
      ]);
      const body = JSON.parse(String(patch.init?.body));
      assert.deepEqual(Object.keys(body.fields).sort(), ["paymentStatus", "updatedAt"]);
      assert.deepEqual(body.fields.paymentStatus, { stringValue: "premium" });
      assert.ok(Number.isFinite(Date.parse(body.fields.updatedAt.timestampValue)));
      assert.equal(body.fields.role, undefined);
      assert.equal(body.fields.allowedApps, undefined);
    }
  });
}
