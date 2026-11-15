// v1.103.0：スキルの zip と、見せてよいかの判定。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { audienceOpen, buildZip, crc32, studentAudience } from "../src/skills-zip.js";

test("crc32 は決まった値", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip はフォルダ 1 つの下に入り、署名と件数が合う", () => {
  const enc = new TextEncoder();
  const z = buildZip("my-skill", [{ path: "SKILL.md", bytes: enc.encode("# hi") }, { path: "refs/a.md", bytes: enc.encode("あ") }]);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const end = z.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  const text = new TextDecoder().decode(z);
  assert.ok(text.includes("my-skill/SKILL.md"));
  assert.ok(text.includes("my-skill/refs/a.md"));
});

test("見せる相手：社内の印は数えず、権利のキーが重なれば見せる。null は全部", () => {
  assert.deepEqual(studentAudience(["本人", "事業部", "shiarabo_basic"]), ["shiarabo_basic"]);
  assert.equal(audienceOpen(["shiarabo_basic"], ["shiarabo_basic", "guest"]), true);
  assert.equal(audienceOpen(["shiarabo_basic"], ["note_membership"]), false);
  assert.equal(audienceOpen(["shiarabo_basic"], []), false);
  assert.equal(audienceOpen(["shiarabo_basic"], null), true);
});
