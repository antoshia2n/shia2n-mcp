/**
 * UTAGE REST API HTTP クライアント v2.0.0
 *
 * v1.0.0 では UTAGE MCP を JSON-RPC tools/call で直叩きしていたが、
 * Scheduled Worker からの定期同期用途では MCP ではなく REST API を使う。
 *
 * REST API:
 * - Base URL: https://api.utage-system.com/v1
 * - Auth: Authorization: Bearer {UTAGE_API_KEY}
 */

export interface UtageAccount {
  id: string;
  name: string;
  type?: string;
  created_at?: string;
}

export interface UtageReader {
  id?: string;
  common_reader_id: string;
  mail: string | null;
  line_display_name: string | null;
  line_picture_url?: string | null;
  is_blocked?: boolean;
  is_line_blocked?: boolean;
  is_mail_error?: boolean;
  is_sms_blocked?: boolean;
  scenario_id?: string;
  scenario_title?: string;
  base_date?: string;
  created_at?: string;
  scenario_fields?: Record<string, unknown>;
  common_fields?: Record<string, unknown>;
  partner?: {
    name?: string;
  };
  funnel_tracking_id?: string;
  funnel_tracking_name?: string;
  message_tracking_id?: string;
  message_tracking_name?: string;
  meta?: Record<string, unknown>;
}

interface UtageApiListResponse<T> {
  data: T[];
  meta?: {
    current_page?: number;
    per_page?: number;
    total?: number;
  };
}

type UnknownRecord = Record<string, unknown>;

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "");
}

function buildUrl(
  apiBase: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>
): string {
  const url = new URL(`${normalizeApiBase(apiBase)}${path}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

async function getUtageApi<T>(
  apiBase: string,
  apiKey: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>
): Promise<T> {
  const url = buildUrl(apiBase, path, query);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`UTAGE REST API HTTP ${response.status}: ${body}`);
  }

  return (await response.json()) as T;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  return undefined;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pickField(raw: UnknownRecord, key: string): unknown {
  if (raw[key] !== undefined && raw[key] !== null) return raw[key];

  const commonFields = asRecord(raw.common_fields);
  if (commonFields?.[key] !== undefined && commonFields?.[key] !== null) {
    return commonFields[key];
  }

  const scenarioFields = asRecord(raw.scenario_fields);
  if (scenarioFields?.[key] !== undefined && scenarioFields?.[key] !== null) {
    return scenarioFields[key];
  }

  return undefined;
}

function normalizeReader(raw: UnknownRecord): UtageReader {
  const commonReaderId = asOptionalString(raw.common_reader_id);
  if (!commonReaderId) {
    throw new Error(`UTAGE reader response missing common_reader_id: ${JSON.stringify(raw)}`);
  }

  const commonFields = asRecord(raw.common_fields);
  const scenarioFields = asRecord(raw.scenario_fields);

  return {
    id: asOptionalString(raw.id),
    common_reader_id: commonReaderId,
    mail: asStringOrNull(pickField(raw, "mail")),
    line_display_name: asStringOrNull(raw.line_display_name),
    line_picture_url: asStringOrNull(raw.line_picture_url),
    is_blocked: asOptionalBoolean(raw.is_blocked),
    is_line_blocked: asOptionalBoolean(raw.is_line_blocked),
    is_mail_error: asOptionalBoolean(raw.is_mail_error),
    is_sms_blocked: asOptionalBoolean(raw.is_sms_blocked),
    scenario_id: asOptionalString(raw.scenario_id),
    scenario_title: asOptionalString(raw.scenario_title),
    base_date: asOptionalString(raw.base_date),
    created_at: asOptionalString(raw.created_at),
    scenario_fields: scenarioFields,
    common_fields: commonFields,
    partner: asRecord(raw.partner) as UtageReader["partner"] | undefined,
    funnel_tracking_id: asOptionalString(raw.funnel_tracking_id),
    funnel_tracking_name: asOptionalString(raw.funnel_tracking_name),
    message_tracking_id: asOptionalString(raw.message_tracking_id),
    message_tracking_name: asOptionalString(raw.message_tracking_name),
    meta: raw,
  };
}

/**
 * UTAGEの配信アカウント一覧を取得
 */
export async function listUtageAccounts(
  apiBase: string,
  apiKey: string
): Promise<UtageAccount[]> {
  const result = await getUtageApi<UtageApiListResponse<UtageAccount>>(
    apiBase,
    apiKey,
    "/accounts"
  );

  return result.data ?? [];
}

/**
 * 指定アカウントの全シナリオ横断読者一覧を取得
 */
export async function listReadersForAccount(
  apiBase: string,
  apiKey: string,
  accountId: string,
  perPage: number = 100,
  page: number = 1
): Promise<UtageReader[]> {
  const result = await getUtageApi<UtageApiListResponse<UnknownRecord>>(
    apiBase,
    apiKey,
    `/accounts/${encodeURIComponent(accountId)}/readers`,
    {
      per_page: perPage,
      page,
    }
  );

  return (result.data ?? []).map(normalizeReader);
}
