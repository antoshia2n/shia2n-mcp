/**
 * 外向けの窓口に出してよい道具の名簿（プログラムに書く側の鍵）。
 *
 * ここに入れてよいのは「つないだ本人のデータだけを触る道具」だけ。
 * Naoki のデータを触る道具（shia2n-mcp の道具）は、ここへ写さない・呼ばない。
 * 道具を足すときは、ここに 1 つ足し、member_access に「権利 × mcp:道具の名前」を足すと、その権利の人にだけ見える。
 *
 * 道具の中身は ctx.memberId（つないだ本人の番号）で必ず絞る。引数で人を指させない。
 */

import { z } from "zod";
import type { Rights } from "./rights.js";

export interface ToolCtx {
  memberId: string;
  /** 使う直前に取り直した、いまの権利 */
  rights: Extract<Rights, { ok: true }>;
  /** この人にいま見えている道具の名前 */
  visible: string[];
}

export interface OfficialTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run(ctx: ToolCtx, args: Record<string, unknown>): Promise<unknown> | unknown;
}

export const OFFICIAL_TOOLS: readonly OfficialTool[] = [
  {
    // 窓口が権利どおりに動いているかを本人が確かめる道具（読むだけ・自分のことだけ）
    name: "official__my_rights",
    description:
      "つないでいる自分の権利の名前と、この窓口でいま使える道具の名前を返す（読むだけ）。自分のことだけを返し、ほかの人のことは返さない。戻り値: { ok: true, 権利: [...], 使える道具: [...] }。",
    shape: {},
    run(ctx) {
      return { ok: true, 権利: ctx.rights.keys, 使える道具: ctx.visible };
    },
  },
];

export const OFFICIAL_TOOL_NAMES: readonly string[] = OFFICIAL_TOOLS.map((t) => t.name);
