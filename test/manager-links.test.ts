// v1.127.0：マネージャーくんのつなぎ（計算だけの部分）。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { docIdOf, notebookText } from "../src/manager-links.js";

test("ドキュメントの番号：住所からも番号だけからも取れる・ほかは断る", () => {
  assert.equal(docIdOf("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?tab=t.0"), "1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  assert.equal(docIdOf("1AbCdEfGhIjKlMnOpQrStUvWxYz012345"), "1AbCdEfGhIjKlMnOpQrStUvWxYz012345");
  assert.equal(docIdOf("https://drive.google.com/drive/folders/abc"), null);
  assert.equal(docIdOf(""), null);
});

test("書き出す中身：台帳の 1 行とピンの全文を、チャットの名前つきで並べる", () => {
  const chats = [{ no: 12, name: "統括の壁打ち", state: "判断待ち", doing: "どちらで進めるか", url: "https://claude.ai/chat/x", touched_at: "2026-11-21T12:00:00Z", initiative_no: "03", initiative_name: "X攻略" }];
  const pins = [{ chat_no: 12, n: 3, title: "確定案", body: "# 本文\n全部", created_at: "2026-11-21T11:00:00Z" }];
  const t = notebookText(chats, pins, "2026-11-22 00:10");
  assert.match(t, /自動で書き出し・2026-11-22 00:10/);
  assert.match(t, /チャット 12｜統括の壁打ち｜判断待ち｜取り組み 03 X攻略｜最後に触った 2026-11-21 21:00｜どちらで進めるか｜https:\/\/claude\.ai\/chat\/x/);
  assert.match(t, /ピン 12#3：確定案（チャット「統括の壁打ち」・2026-11-21 20:00）\n# 本文\n全部/);
  // 日時の行を除けば、同じ中身から同じ文になる（変わっていないときは書かない判定に使う）
  assert.equal(notebookText(chats, pins, ""), notebookText(chats, pins, ""));
});
