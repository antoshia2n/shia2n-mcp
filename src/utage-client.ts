/**
 * UTAGE MCP HTTP クライアント v1.0.0
 *
 * UTAGE MCP は JSON-RPC 形式。Bearer 認証で tools/call メソッドを叩く。
 * shia2n-mcp からは shia2n の 4 UTAGE アカウントに対して並列 fetch する。
 */

export interface UtageAccount {
  id: string;
  name: string;
  type: string;
}

export interface UtageReader {
  common_reader_id: string;
  mail: string | null;
  line_display_name: string | null;
  is_blocked?: boolean;
  is_mail_error?: boolean;
  scenario_id?: string;
  scenario_title?: string;
  base_date?: string;
  created_at?: string;
  meta?: Record<string, unknown>;
}

interface McpJsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * UTAGE MCP tools/call を叩く共通関数
 */
async function callUtageTool<T = unknown>(
  url: string,
  token: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`UTAGE MCP HTTP ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as McpJsonRpcResponse<T>;
  if (data.error) {
    throw new Error(`UTAGE MCP error: ${data.error.message}`);
  }

  // MCP レスポンスの content[0].text に JSON 文字列が入る形式
  const textContent = data.result?.content?.[0]?.text;
  if (!textContent) {
    throw new Error("UTAGE MCP response: no content");
  }

  return JSON.parse(textContent) as T;
}

/**
 * shia2n の UTAGE アカウント一覧を取得
 */
export async function listUtageAccounts(
  url: string,
  token: string
): Promise<UtageAccount[]> {
  const result = await callUtageTool<{ data: UtageAccount[] }>(
    url,
    token,
    "message_account_list",
    {}
  );
  return result.data ?? [];
}

/**
 * 指定アカウントの全シナリオ横断読者一覧を取得
 */
export async function listReadersForAccount(
  url: string,
  token: string,
  accountId: string,
  perPage: number = 100,
  page: number = 1
): Promise<UtageReader[]> {
  const result = await callUtageTool<{ data: UtageReader[] }>(
    url,
    token,
    "message_reader_list_all",
    {
      account_id: accountId,
      per_page: perPage,
      page,
    }
  );
  return result.data ?? [];
}
