// v1.54.0：つながっている先の一覧と取り消し。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { listConnections } from "../src/tools-mcp-auth.js";

test("一覧：名乗り・戻り先の住所・日本時間・ログインを通ったかを返し、札は返さない。古い順", async () => {
  const provider = {
    async listUserGrants(_u: string, o?: { cursor?: string }) {
      if (!o?.cursor) return { items: [{ id: "g2", clientId: "c2", createdAt: 1793000000, metadata: { login: "firebase" } }], cursor: "next" };
      return { items: [{ id: "g1", clientId: "c1", createdAt: 1790000000, metadata: {} }, { id: "g3", clientId: "gone", createdAt: 1791000000 }] };
    },
    async revokeGrant() {},
    async lookupClient(id: string) {
      if (id === "c1") return { clientName: "Claude", redirectUris: ["https://claude.ai/api/mcp/auth_callback", "https://claude.ai/x"] };
      if (id === "c2") return { clientName: "ChatGPT", redirectUris: ["https://chatgpt.com/cb"] };
      return null;
    },
  };
  const list = await listConnections(provider as any, "u");
  assert.deepEqual(list.map(x => x.grant_id), ["g1", "g3", "g2"]);
  assert.deepEqual(list[0].戻り先, ["claude.ai"]);
  assert.equal(list[0].login_checked, false);
  assert.equal(list[2].login_checked, true);
  assert.deepEqual(list[1].戻り先, ["（つなぎ先の登録が消えている）"]);
  assert.ok(String(list[0].つないだ日時).endsWith("（日本時間）"));
  assert.ok(!JSON.stringify(list).includes("token"));
});
