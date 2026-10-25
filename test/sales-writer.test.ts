// v1.44.0：B が売上管理を入金済みにする口の引数の確かめ。走らせ方：esbuild で束ねてから node --test
import test from "node:test";
import assert from "node:assert/strict";
import { checkMarkArgs } from "../src/sales-writer-core.js";

test("そろった引数は通し、契約の番号は文字にそろえる", () => {
  assert.deepEqual(checkMarkArgs({ contract_id: 4, year_month: "2026-11", paid_date: "2026-11-06", actual_amount: 22000 }),
    { ok: true, args: { contract_id: "4", year_month: "2026-11", paid_date: "2026-11-06", actual_amount: 22000 } });
});

test("形の違う引数は理由をつけて断る（sales-manager を呼ぶ前に止める）", () => {
  const base = { contract_id: "27", year_month: "2026-11", paid_date: "2026-11-12", actual_amount: 15000 };
  assert.equal((checkMarkArgs({ ...base, contract_id: "abc" }) as any).error, "bad_contract_id");
  assert.equal((checkMarkArgs({ ...base, year_month: "2025-12" }) as any).error, "bad_year_month");
  assert.equal((checkMarkArgs({ ...base, year_month: "2026-13" }) as any).error, "bad_year_month");
  assert.equal((checkMarkArgs({ ...base, paid_date: "2026-02-30" }) as any).error, "bad_paid_date");
  assert.equal((checkMarkArgs({ ...base, paid_date: "2026-02-45" }) as any).error, "bad_paid_date");
  assert.equal((checkMarkArgs({ ...base, actual_amount: 15000.5 }) as any).error, "bad_amount");
  assert.equal((checkMarkArgs({ ...base, actual_amount: -1 }) as any).error, "bad_amount");
  assert.equal((checkMarkArgs(null) as any).error, "bad_contract_id");
});
