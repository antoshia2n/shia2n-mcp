/**
 * つないだ人ごとに MCP の窓口を組む。呼ばれるたびに組み直すので、権利が変われば次の一覧から変わる。
 *
 * 鍵は 3 つ：
 *   ① 一覧を作るとき：いまの権利で見える道具だけを返す（見えない道具は名前も説明文も出ない）
 *   ② 道具を使うとき：その場で権利を取り直し、まだ使えるときだけ動かす（期限切れ・取り消しはその場で断る）
 *   ③ shia2n-mcp の側でも、もう一度権利と名簿を確かめてから、本人の番号で動かす（GATE.run）
 *
 * v0.2.0：shia2n-mcp の道具（X攻略くんの 8 本）を、説明文と引数の形ごと GATE から受け取るため、
 * 一覧と呼び出しを MCP の低い層の受け口で答える形にした。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allowedToolNames, canConnect, type Rights } from "./rights.js";
import { GATE_TOOL_NAMES, OFFICIAL_TOOLS, OFFICIAL_TOOL_NAMES, type OfficialTool } from "./tools.js";
import { VERSION } from "./version.js";

export interface GateToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }
export type GateRun = { ok: true; result: { content: unknown[]; isError?: boolean } } | { ok: false; reason: string };

export interface GateBinding {
  login(idToken: string): Promise<Rights>;
  rights(memberId: string): Promise<Rights>;
  tools(names: string[]): Promise<GateToolInfo[]>;
  run(memberId: string, name: string, args: unknown): Promise<GateRun>;
}

const text = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const RUN_DENY: Record<string, string> = {
  no_right: "この道具を使う権利がありません",
  no_login: "会員のログインの番号がまだ結ばれていません。シアラボの画面に一度ログインしてから、もう一度試してください",
  lookup_failed: "いま権利を確かめられませんでした。少し待ってからもう一度試してください",
};

export function buildServer(
  gate: Pick<GateBinding, "rights" | "tools" | "run">,
  memberId: string,
  rights: Extract<Rights, { ok: true }>,
  local: readonly OfficialTool[] = OFFICIAL_TOOLS,
  gateNames: readonly string[] = GATE_TOOL_NAMES,
): McpServer {
  const server = new McpServer({ name: "shia2n-official", version: VERSION });
  const names = [...local.map((t) => t.name), ...gateNames];
  server.server.registerCapabilities({ tools: {} });

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visible = allowedToolNames(names, rights.targets);
    const out: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
    for (const t of local) {
      if (!visible.includes(t.name)) continue;
      const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
      delete schema.$schema;
      out.push({ name: t.name, description: t.description, inputSchema: schema });
    }
    const askGate = gateNames.filter((n) => visible.includes(n));
    if (askGate.length) {
      let infos: GateToolInfo[] = [];
      try { infos = await gate.tools([...askGate]); } catch { infos = []; }
      for (const i of infos) if (askGate.includes(i.name)) out.push({ name: i.name, description: i.description, inputSchema: i.inputSchema });
    }
    return { tools: out };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const now = await gate.rights(memberId);
    if (!now.ok) return text({ ok: false, message: RUN_DENY.lookup_failed }, true);
    const nowVisible = allowedToolNames(names, now.targets);
    if (!canConnect(now.targets) || !nowVisible.includes(name)) return text({ ok: false, message: RUN_DENY.no_right }, true);

    const tool = local.find((t) => t.name === name);
    if (tool) {
      const parsed = z.object(tool.shape).safeParse(args);
      if (!parsed.success) return text({ ok: false, message: "引数の形が違います" }, true);
      try { return text(await tool.run({ memberId, rights: now, visible: nowVisible }, parsed.data)); }
      catch { return text({ ok: false, message: "道具の中で失敗しました" }, true); }
    }
    let r: GateRun;
    try { r = await gate.run(memberId, name, args); } catch { r = { ok: false, reason: "lookup_failed" }; }
    if (!r.ok) return text({ ok: false, message: RUN_DENY[r.reason] ?? "この道具は使えません" }, true);
    return r.result as never;
  });

  return server;
}

export { OFFICIAL_TOOL_NAMES };
