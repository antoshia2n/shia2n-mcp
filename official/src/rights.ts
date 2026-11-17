/**
 * 権利から「つなげるか」「どの道具が見えるか」を決める（中身だけ・外へは何も呼ばない）。
 *
 * 決まり（2026-11-17 Naoki OK）：
 *   ・つなげるのは、開くもの（member_access の target）に mcp_official がある人だけ
 *   ・見える道具は、プログラムの名簿（tools.ts の OFFICIAL_TOOLS）と、開くものの「mcp:道具の名前」の両方に載っているものだけ
 *     → 表に Naoki 用の道具の名前を書き間違えても、名簿に無いので出ようがない
 *   ・新しいプランは member_access に「プランの権利 × mcp_official」と「プランの権利 × mcp:道具の名前」を足すだけ
 */

export const CONNECT_TARGET = "mcp_official";
export const TOOL_TARGET_PREFIX = "mcp:";

/** 門番の口（shia2n-mcp の OfficialGate）が返す形 */
export type Rights = { ok: true; member_id: string; keys: string[]; targets: string[] } | { ok: false; reason: string };

export function canConnect(targets: readonly string[]): boolean {
  return targets.includes(CONNECT_TARGET);
}

/** 名簿の中から、この人に見せてよい道具の名前だけを残す（名簿の並びのまま） */
export function allowedToolNames(registry: readonly string[], targets: readonly string[]): string[] {
  if (!canConnect(targets)) return [];
  const open = new Set(targets.filter((t) => t.startsWith(TOOL_TARGET_PREFIX)).map((t) => t.slice(TOOL_TARGET_PREFIX.length)));
  return registry.filter((name) => open.has(name));
}
