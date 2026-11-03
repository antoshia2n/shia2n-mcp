import test from "node:test";
import assert from "node:assert/strict";
import { addItems, parseMapRef, moveNode, findTable, putTrow, splitLink, bodyOf, cleanName, countNodes, findRequests, markChecks, newMapTree, parseBullets, sameName, titleOf, toOutline, type MNodes } from "../src/mindmap-core.ts";

const base = (): MNodes => ({
  r: { id: "r", text: "26年の戦略", children: ["a", "b"], parent: null, collapsed: false, color: null, side: null },
  a: { id: "a", text: "目的の状態", children: ["a1"], parent: "r", color: "b1", side: "r", ai: "根拠を3つ足して" },
  a1: { id: "a1", text: "毎朝の現在地", children: [], parent: "a", check: "todo", memo: "長い\n文章" },
  b: { id: "b", text: "誰の", children: [], parent: "r", color: "b2", side: "l", collapsed: true },
});

test("箇条書きの文字にする：{id}・チェック・メモ・AI への指示", () => {
  const o = toOutline("r", base());
  assert.match(o, /^# 26年の戦略 \{r\}/);
  assert.match(o, /- 目的の状態 \{a\}\n  AI への指示: 根拠を3つ足して/);
  assert.match(o, /  - \[ \] 毎朝の現在地 \{a1\}\n    メモ: 長い \/ 文章/);
  assert.equal(toOutline("r", base(), "a").split("\n")[0], "# 目的の状態 {a}");
});

test("AI への指示の枝を集める", () => {
  const q = findRequests("r", base());
  assert.equal(q.length, 1);
  assert.equal(q[0].道すじ, "26年の戦略 > 目的の状態");
});

test("箇条書きを読む：字下げ・全角の空白・チェック", () => {
  const it = parseBullets("- 論点A\n  - 根拠\n　・根拠2\n- [x] 論点B\n・「」論点C");
  assert.deepEqual(it.map((x) => x.text), ["論点A", "論点B", "論点C"]);
  assert.deepEqual(it[0].children.map((x) => x.text), ["根拠", "根拠2"]);
  assert.equal(it[1].check, "done");
  assert.equal(it[2].check, "todo");
});

test("枝を足す：全部に by ai・中心の直下は色と左右・たたんだ枝は開く", () => {
  const n = base();
  const made = addItems("r", n, "r", parseBullets("- 新しい論点\n  - 子"), "出どころ");
  assert.equal(made.length, 2);
  const top = n[made[0]];
  assert.equal(top.by, "ai"); assert.equal(n[made[1]].by, "ai");
  assert.equal(top.color, "b3"); assert.equal(top.side, "r");
  assert.equal(top.memo, "出どころ");
  assert.equal(n[made[1]].parent, made[0]);
  assert.deepEqual(n.r.children.slice(0, 2), ["a", "b"]);
  addItems("r", n, "b", parseBullets("- 下"));
  assert.equal(n.b.collapsed, false);
  assert.match(bodyOf(n), /新しい論点/);
  assert.throws(() => addItems("r", n, "zz", parseBullets("x")));
});

test("チェックを済みにする・見つからない枝は分けて返す", () => {
  const n = base();
  const r = markChecks(n, ["a1", "b", "nope"], true);
  assert.deepEqual(r.変えた, ["a1", "b"]); assert.deepEqual(r.見つからない, ["nope"]);
  assert.equal(n.a1.check, "done");
  assert.deepEqual(markChecks(n, ["a1"], true).変えた, []);
});

test("新しいマップの木：白紙は中心 1 つだけ・名前が中心の文字", () => {
  const t = newMapTree("26年10月27日｜オンラインビジネス攻略");
  assert.deepEqual(Object.keys(t.nodes), [t.root]);
  assert.deepEqual(t.nodes[t.root], { id: t.root, text: "26年10月27日｜オンラインビジネス攻略", children: [], parent: null, collapsed: false, color: null, side: null });
  assert.equal(titleOf(t.root, t.nodes), "26年10月27日｜オンラインビジネス攻略");
  assert.equal(countNodes(t.nodes), 0);
  assert.deepEqual(t.made, []);
});

test("新しいマップの木：最初の枝は中心の子・全部に by ai・色と左右を回す", () => {
  const t = newMapTree("題", parseBullets("- 導入\n  - つかみ\n- 本題\n- まとめ"));
  assert.equal(t.made.length, 4);
  assert.equal(countNodes(t.nodes), 4);
  const top = t.nodes[t.root].children.map((id) => t.nodes[id]);
  assert.deepEqual(top.map((n) => n.text), ["導入", "本題", "まとめ"]);
  assert.deepEqual(top.map((n) => [n.color, n.side]), [["b1", "r"], ["b2", "l"], ["b3", "r"]]);
  assert.ok(t.made.every((id) => t.nodes[id].by === "ai"));
  assert.equal(t.nodes[t.root].by, undefined);
  assert.match(toOutline(t.root, t.nodes), /^# 題 \{n[a-z0-9]+\}\n- 導入 \(AI\)/);
});

test("名前：改行は空白に・同じ名前は空白の違いを見ない", () => {
  assert.equal(cleanName("  題\n  続き "), "題 続き");
  assert.ok(sameName("26年11月3日｜リサーチ", " 26年11月3日｜リサーチ "));
  assert.ok(sameName("a  b", "a b"));
  assert.ok(!sameName("26年11月3日｜リサーチ", "26年11月10日｜リサーチ"));
});

test("行の末尾のリンク：(リンク …)・素の URL・get_map の行をそのまま書き戻す", () => {
  const it = parseBullets([
    "- 自己紹介のポスト (リンク https://x.com/antoshia2n/status/1)",
    "- 伸ばし方の例 https://x.com/antoshia2n/status/2",
    "  - 子の枝 (AI) (リンク https://x.com/a/status/3) {n1a2b3c4}",
    "- https://x.com/a/status/4",
    "- 文の途中の https://x.com/a/status/5 は外さない",
    "- [x] 済みの枝（リンク https://example.com/a）",
    "- 壊れたリンク (リンク javascript:alert(1))",
  ].join("\n"));
  assert.deepEqual(it.map((x) => [x.text, x.link]), [
    ["自己紹介のポスト", "https://x.com/antoshia2n/status/1"],
    ["伸ばし方の例", "https://x.com/antoshia2n/status/2"],
    ["https://x.com/a/status/4", "https://x.com/a/status/4"],
    ["文の途中の https://x.com/a/status/5 は外さない", undefined],
    ["済みの枝", "https://example.com/a"],
    ["壊れたリンク (リンク javascript:alert(1))", undefined],
  ]);
  assert.deepEqual([it[1].children[0].text, it[1].children[0].link], ["子の枝", "https://x.com/a/status/3"]);
  assert.equal(it[4].check, "done");
  const n = base(); const made = addItems("r", n, "r", it.slice(0, 1));
  assert.equal(n[made[0]].link, "https://x.com/antoshia2n/status/1");
  const o = toOutline("r", n); assert.match(o, /- 自己紹介のポスト \(AI\) \(リンク https:\/\/x\.com\/antoshia2n\/status\/1\) \{/);
  // 書き戻しても同じ文字とリンクになる
  const line = o.split("\n").find((l) => l.includes("自己紹介のポスト"))!;
  assert.deepEqual(splitLink(line.replace(/^\s*- /, "")), { text: "自己紹介のポスト", link: "https://x.com/antoshia2n/status/1" });
});

test("parseMapRef：番号・/m/ の住所・/s/ の共有リンクを読み分ける（2026-11-03）", () => {
  assert.deepEqual(parseMapRef("abc-123"), { kind: "id", value: "abc-123" });
  assert.deepEqual(parseMapRef("https://mindmap.shia2n.jp/m/abc-123"), { kind: "id", value: "abc-123" });
  assert.deepEqual(parseMapRef(" https://mindmap.shia2n.jp/s/Xy_z-9AbC/ "), { kind: "share", value: "Xy_z-9AbC" });
  assert.equal(parseMapRef("https://example.com/s/abc"), null);
  assert.equal(parseMapRef("https://mindmap.shia2n.jp/other/abc"), null);
  assert.equal(parseMapRef("a b"), null);
  assert.equal(parseMapRef(""), null);
});

test("moveNode：AI の枝だけ動かす・子や孫へは動かさない・中心の直下は色と左右（2026-11-03）", () => {
  const nodes: MNodes = {
    r: { id: "r", text: "中心", children: ["a", "b"], parent: null },
    a: { id: "a", text: "Naoki", children: ["c"], parent: "r", color: "b1", side: "r" },
    b: { id: "b", text: "AI 1", children: ["d"], parent: "r", color: "b2", side: "l", by: "ai" },
    c: { id: "c", text: "Naoki の子", children: [], parent: "a" },
    d: { id: "d", text: "AI 2", children: [], parent: "b", by: "ai" },
  };
  moveNode("r", nodes, "b", "a", 0);
  assert.deepEqual(nodes.a.children, ["b", "c"]);
  assert.deepEqual(nodes.r.children, ["a"]);
  assert.equal(nodes.b.parent, "a"); assert.equal(nodes.b.color, null); assert.equal(nodes.b.side, null);
  assert.deepEqual(nodes.b.children, ["d"]);
  assert.throws(() => moveNode("r", nodes, "c", "r"), /Naoki/);
  assert.throws(() => moveNode("r", nodes, "b", "d"), /子や孫/);
  assert.throws(() => moveNode("r", nodes, "r", "a"), /中心/);
  moveNode("r", nodes, "d", "r");
  assert.deepEqual(nodes.r.children, ["a", "d"]); assert.equal(nodes.d.color, "b2"); assert.equal(nodes.d.side, "l");
});

test("findTable と putTrow：同じフォルダの表だけ・列の値は残す（2026-11-03）", () => {
  const data: any = { tables: [{ id: "t1", fid: "f1", name: "攻略" }, { id: "t2", fid: "f2", name: "攻略" }], trows: { m1: { t: null, v: { c1: "済み" } } } };
  assert.equal(findTable(data, "f1", "攻略")?.id, "t1");
  assert.equal(findTable(data, "f2", " 攻略 ")?.id, "t2");
  assert.equal(findTable(data, "f1", "t2"), null);
  putTrow(data, "m1", "t1"); putTrow(data, "m2", "t1");
  assert.deepEqual(data.trows.m1, { t: "t1", v: { c1: "済み" } });
  assert.deepEqual(data.trows.m2, { t: "t1", v: {} });
});
