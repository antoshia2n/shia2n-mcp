/**
 * つないだ人ごとに MCP の窓口を組む。呼ばれるたびに組み直すので、権利が変われば次の一覧から変わる。
 *
 * 鍵は 2 つ：
 *   ① 一覧を作るとき：いまの権利で見える道具だけを登録する（見えない道具は名前も説明文も出ない）
 *   ② 道具を使うとき：その場で権利を取り直し、まだ使えるときだけ動かす（期限切れ・取り消しはその場で断る）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { allowedToolNames, canConnect, type Rights } from "./rights.js";
import { OFFICIAL_TOOLS, OFFICIAL_TOOL_NAMES, type OfficialTool } from "./tools.js";
import { VERSION } from "./version.js";

export interface GateBinding {
  login(idToken: string): Promise<Rights>;
  rights(memberId: string): Promise<Rights>;
}

const text = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function buildServer(
  gate: Pick<GateBinding, "rights">,
  memberId: string,
  rights: Extract<Rights, { ok: true }>,
  registry: readonly OfficialTool[] = OFFICIAL_TOOLS,
): McpServer {
  const server = new McpServer({ name: "shia2n-official", version: VERSION });
  const names = registry.map((t) => t.name);
  const visible = allowedToolNames(names, rights.targets);

  if (!visible.length) {
    // 道具が 0 本でも「一覧は空」と答える（何も登録しないと一覧の問い合わせ自体が断られるため）
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    return server;
  }

  for (const tool of registry) {
    if (!visible.includes(tool.name)) continue;
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args: Record<string, unknown>) => {
      const now = await gate.rights(memberId);
      if (!now.ok) return text({ ok: false, message: "権利を確かめられませんでした。少し待ってからもう一度試してください" }, true);
      const nowVisible = allowedToolNames(names, now.targets);
      if (!canConnect(now.targets) || !nowVisible.includes(tool.name)) {
        return text({ ok: false, message: "この道具を使う権利がありません" }, true);
      }
      try {
        return text(await tool.run({ memberId, rights: now, visible: nowVisible }, args ?? {}));
      } catch {
        return text({ ok: false, message: "道具の中で失敗しました" }, true);
      }
    });
  }
  return server;
}

export { OFFICIAL_TOOL_NAMES };
