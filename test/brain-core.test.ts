// v1.130.0：ブレインくんの道具の決まり。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { plainText, linksIn, searchBrain, tidyCandidates, type BrNote } from "../src/brain-core.js";

const N = (id: string, kind: string, title: string, body = "", o: Partial<BrNote> = {}): BrNote => ({ id, kind, use_id: null, title, folder: "", status: "s1", lines: body ? [{ t: body }] : [], aliases: [], daily: null, touched_at: "2026-11-2" + id.length, created_at: "", ...o });

test("plainText・linksIn：リンクは表示の言葉／題だけ", () => {
  assert.equal(plainText([{ t: "勉強は[[わからない時間|時間]]の**問題**" }]), "勉強は時間の問題");
  assert.deepEqual(linksIn([{ t: "[[a|x]] [[b]] [[a]]" }]), ["a", "b"]);
});
test("searchBrain：種類で絞り、題の当たりが上", () => {
  const ns = [N("a", "memo", "朝", "思考体力が要る"), N("bb", "kw", "思考体力", "", { use_id: "u1" })];
  const r = searchBrain(ns, "思考体力", { uses: new Map([["u1", "言葉"]]) });
  assert.deepEqual(r.map(h => h.id), ["bb", "a"]);
  assert.equal(r[0].use, "言葉"); assert.equal(r[0].kind, "キーワード");
  assert.deepEqual(searchBrain(ns, "思考", { kind: "memo" }).map(h => h.id), ["a"]);
});
test("tidyCandidates：重複と近い表記ゆれだけ（メモ・違う種類は出さない）", () => {
  const ns = [N("1", "kw", "思考体力"), N("2", "kw", "思考 体力"), N("3", "kw", "思考体力論"), N("4", "pt", "思考体力"), N("5", "memo", "思考体力"), N("6", "kw", "陽キャ・内向型"), N("7", "kw", "内")];
  const t = tidyCandidates(ns);
  assert.equal(t.filter(x => x.reason === "重複").length, 1);
  assert.deepEqual(t.find(x => x.reason === "重複")!.notes.map(n => n.id), ["1", "2"]);
  assert.ok(t.some(x => x.reason === "表記ゆれ" && x.notes.some(n => n.id === "3")));
  assert.ok(!t.some(x => x.notes.some(n => n.id === "5" || n.id === "4" && x.kind === "キーワード")));
  assert.ok(!t.some(x => x.notes.some(n => n.id === "6")));
});
