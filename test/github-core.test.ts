// v1.7.0：github__open_pr の計算部分。走らせ方：node --test test/github-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyEdits, EditError, sha256Hex, utf8Bytes, base64ToBytes, decodeBase64Utf8 } from "../src/github-core.ts";

test("sha256 は公開の見本と同じ値（abc）", async () => {
  assert.equal(await sha256Hex(utf8Bytes("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("日本語の文字も、手元の sha256sum（node の createHash）と同じ値", async () => {
  const s = "会員の門番\n改行あり\r\n終わり";
  assert.equal(await sha256Hex(utf8Bytes(s)), createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"));
});

test("画像など base64 は、元のバイト列の sha256 になる", async () => {
  const raw = Buffer.from([0, 255, 1, 128, 10, 13]);
  const b64 = raw.toString("base64");
  assert.equal(base64ToBytes(b64).length, 6);
  assert.equal(await sha256Hex(base64ToBytes(b64)), createHash("sha256").update(raw).digest("hex"));
});

test("base64 の改行入り（GitHub の contents の形）も読める", () => {
  const b64 = Buffer.from("あいう", "utf8").toString("base64");
  assert.equal(decodeBase64Utf8(b64.slice(0, 4) + "\n" + b64.slice(4)), "あいう");
});

test("置き換えは上から順に当たる", () => {
  assert.equal(applyEdits("a-b-c", "x.ts", [{ old_str: "a-", new_str: "A-" }, { old_str: "A-b", new_str: "AB" }]), "AB-c");
});

test("置き換えの文字に $ が入っても、そのまま入る", () => {
  assert.equal(applyEdits("price", "x.ts", [{ old_str: "price", new_str: "$& $1 $$" }]), "$& $1 $$");
});

test("探す文字列が 0 か所なら止める", () => {
  assert.throws(() => applyEdits("abc", "x.ts", [{ old_str: "z", new_str: "y" }]), (e: unknown) => e instanceof EditError && /0 か所/.test((e as Error).message));
});

test("探す文字列が 2 か所なら止める", () => {
  assert.throws(() => applyEdits("aa", "x.ts", [{ old_str: "a", new_str: "b" }]), (e: unknown) => e instanceof EditError && /2 か所/.test((e as Error).message));
});
