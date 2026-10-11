// v1.8.0：把握くんの目標欄 2 本の数え方。走らせ方：node --test test/haaku-goal-count.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { countShiaraboContracts, sumConfirmed, jstYearMonth, toManYen } from "../src/haaku-goal-count.ts";

test("しあらぼは契約の行と、行がまだ無い有効な契約を数え、ほかの区分と単発の行は数えない", () => {
  const rows = [
    { source: "contract", contract_id: 40, business: "しあらぼ継続" },
    { source: "contract", contract_id: 44, business: "しあらぼ新規" },
    { source: "planned", contract_id: 50, business: "しあらぼ新規" },
    { source: "contract", contract_id: 16, business: "CW案件" },
    { source: "single", contract_id: null, business: "しあらぼ新規" },
  ];
  assert.equal(countShiaraboContracts(rows), 3);
});

test("同じ契約の行が 2 つあっても 1 人", () => {
  const rows = [
    { source: "contract", contract_id: 44, business: "しあらぼ新規" },
    { source: "contract", contract_id: "44", business: "しあらぼ新規" },
  ];
  assert.equal(countShiaraboContracts(rows), 1);
});

test("4 区分の確定を足す（CW案件は入れない）", () => {
  const by = {
    "X広告収益": { confirmed: 0 },
    "メンシプ": { confirmed: 0 },
    "しあらぼ新規": { confirmed: 15000 },
    "しあらぼ継続": { confirmed: 22000 },
    "CW案件": { confirmed: 22000 },
  };
  assert.equal(sumConfirmed(by), 37000);
  assert.equal(toManYen(37000), 3.7);
});

test("区分が返ってこなければ 0 にせず止める", () => {
  assert.throws(() => sumConfirmed({ "X広告収益": { confirmed: 0 } }), /メンシプ/);
});

test("年月は日本の時刻で読む（UTC 10/31 18:30 は日本の 11/1 03:30）", () => {
  assert.equal(jstYearMonth(new Date("2026-10-31T18:30:00Z")), "2026-11");
  assert.equal(jstYearMonth(new Date("2026-10-11T12:00:00Z")), "2026-10");
});
