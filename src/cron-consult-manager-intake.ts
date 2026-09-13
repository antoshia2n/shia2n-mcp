/**
 * UTAGE の個別相談予約者をコンサルマネージャーへ取り込む。
 *
 * - 入口はイベント sc2kI5iuQBqT の 1 本だけ
 * - 2026 年の日程だけを ic_persons へ追加する
 * - source='UTAGE' かつ email 一致で二重登録を防ぐ
 * - ic_kpis.actual_zoom は予約日の日付で月ごとに入れ直す（month_idx は 0 始まり）
 * - UTAGE 側には書き込まない
 */

import type { Env } from "./index.js";

const EVENT_ID = "sc2kI5iuQBqT";
const SOURCE = "UTAGE";
const TARGET_YEAR = 2026;
const DEFAULT_UTAGE_MCP_URL = "https://api.utage-system.com/mcp";

type Row = Record<string, unknown>;

interface McpResponse {
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { code?: number; message?: string };
}

export interface ConsultManagerIntakeSummary {
  applicants_total: number;
  applicants_2026: number;
  inserted: number;
  persons_after: number;
  actual_zoom: Record<string, number>;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function asRecord(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function firstText(row: Row, keys: string[]): string | null {
  for (const key of keys) {
    const value = asText(row[key]);
    if (value) return value;
  }
  return null;
}

function applicantName(row: Row): string | null {
  const direct = firstText(row, ["name", "full_name", "applicant_name", "reader_name"]);
  if (direct) return direct;
  const family = firstText(row, ["sei", "last_name", "family_name"]);
  const given = firstText(row, ["mei", "first_name", "given_name"]);
  const joined = [family, given].filter(Boolean).join(" ").trim();
  return joined || null;
}

function dateFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    const iso = value.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
    if (iso) {
      return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    }
    const ja = value.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
    if (ja) {
      return `${ja[1]}-${ja[2].padStart(2, "0")}-${ja[3].padStart(2, "0")}`;
    }
    return null;
  }
  const nested = asRecord(value);
  if (!nested) return null;
  return applicantDate(nested);
}

function applicantDate(row: Row): string | null {
  const keys = [
    "event_start_date",
    "schedule_start_date",
    "start_date",
    "schedule_date",
    "reserved_date",
    "date",
    "start_at",
    "event_schedule",
    "schedule",
  ];
  for (const key of keys) {
    const date = dateFromValue(row[key]);
    if (date) return date;
  }
  return null;
}

function applicantRows(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter((row): row is Row => row !== null);
  const root = asRecord(payload);
  if (!root) return [];
  for (const key of ["data", "applicants", "items", "results"]) {
    const value = root[key];
    if (Array.isArray(value)) {
      return value.map(asRecord).filter((row): row is Row => row !== null);
    }
  }
  return [];
}

async function listEventApplicants(env: Env): Promise<Row[]> {
  const url = requireEnv("UTAGE_MCP_URL", env.UTAGE_MCP_URL || DEFAULT_UTAGE_MCP_URL);
  const token = requireEnv("UTAGE_MCP_TOKEN", env.UTAGE_MCP_TOKEN);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "event_applicant_list",
        arguments: { event_id: EVENT_ID },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`UTAGE MCP HTTP ${response.status}: ${await response.text()}`);
  }
  const rpc = await response.json() as McpResponse;
  if (rpc.error) {
    throw new Error(`UTAGE MCP error: ${rpc.error.message ?? rpc.error.code ?? "unknown"}`);
  }
  const text = rpc.result?.content?.find((item) => item.type === "text" && item.text)?.text;
  if (!text) throw new Error("UTAGE MCP response: no text content");
  const rows = applicantRows(JSON.parse(text));
  if (rows.length === 0) throw new Error("UTAGE event applicants returned 0 rows");
  return rows;
}

function supabaseHeaders(env: Env, prefer?: string): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function sbGet(env: Env, path: string): Promise<Row[]> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    headers: supabaseHeaders(env),
  });
  if (!response.ok) {
    throw new Error(`Supabase read failed (${response.status}): ${await response.text()}`);
  }
  return await response.json() as Row[];
}

async function sbInsert(env: Env, path: string, rows: Row[]): Promise<Row[]> {
  if (rows.length === 0) return [];
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "POST",
    headers: supabaseHeaders(env, "return=representation"),
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    throw new Error(`Supabase insert failed (${response.status}): ${await response.text()}`);
  }
  return await response.json() as Row[];
}

async function sbPatch(env: Env, path: string, body: Row): Promise<Row[]> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method: "PATCH",
    headers: supabaseHeaders(env, "return=representation"),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Supabase update failed (${response.status}): ${await response.text()}`);
  }
  return await response.json() as Row[];
}

async function personCount(env: Env): Promise<number> {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/ic_persons?select=id&limit=1`,
    { headers: supabaseHeaders(env, "count=exact") }
  );
  if (!response.ok) {
    throw new Error(`Supabase count failed (${response.status}): ${await response.text()}`);
  }
  const range = response.headers.get("content-range") ?? "";
  const total = Number(range.split("/")[1]);
  if (!Number.isInteger(total)) throw new Error(`Invalid Content-Range: ${range}`);
  return total;
}

export async function syncConsultManagerIntake(
  env: Env
): Promise<ConsultManagerIntakeSummary> {
  requireEnv("SUPABASE_URL", env.SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY);

  const rawApplicants = await listEventApplicants(env);
  const parsed = rawApplicants.map((row, index) => {
    const date = applicantDate(row);
    const name = applicantName(row);
    const email = firstText(row, ["mail", "email"]);
    if (!date) {
      throw new Error(`Applicant ${index + 1}: schedule date is missing; keys=${Object.keys(row).join(",")}`);
    }
    return { date, name, email };
  });

  const target = parsed.filter((item) => item.date.startsWith(`${TARGET_YEAR}-`));
  const invalid = target.filter((item) => !item.name || !item.email);
  if (invalid.length > 0) {
    throw new Error(`2026 applicants missing name or email: ${invalid.length}`);
  }

  const existingRows = await sbGet(
    env,
    `/ic_persons?select=email&source=eq.${encodeURIComponent(SOURCE)}`
  );
  const existingEmails = new Set(
    existingRows
      .map((row) => asText(row.email)?.toLowerCase())
      .filter((email): email is string => Boolean(email))
  );

  const uniqueTarget = new Map<string, { name: string; email: string; date: string }>();
  for (const item of target) {
    const email = item.email!.toLowerCase();
    const current = uniqueTarget.get(email);
    if (!current || item.date < current.date) {
      uniqueTarget.set(email, { name: item.name!, email: item.email!, date: item.date });
    }
  }

  const rowsToInsert = [...uniqueTarget.values()]
    .filter((item) => !existingEmails.has(item.email.toLowerCase()))
    .map((item) => ({
      name: item.name,
      source: SOURCE,
      email: item.email,
      first_date: item.date,
    }));

  const insertedRows = await sbInsert(env, "/ic_persons", rowsToInsert);

  const monthCounts = Array.from({ length: 12 }, () => 0);
  for (const item of target) {
    const monthIndex = Number(item.date.slice(5, 7)) - 1;
    if (monthIndex >= 0 && monthIndex < 12) monthCounts[monthIndex]++;
  }

  const kpis = await sbGet(env, "/ic_kpis?select=month_idx&order=month_idx.asc");
  const actualZoom: Record<string, number> = {};
  for (const row of kpis) {
    const monthIndex = Number(row.month_idx);
    if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
      throw new Error(`Invalid ic_kpis.month_idx: ${String(row.month_idx)}`);
    }
    const value = monthCounts[monthIndex];
    const changed = await sbPatch(
      env,
      `/ic_kpis?month_idx=eq.${monthIndex}`,
      { actual_zoom: value }
    );
    if (changed.length !== 1) {
      throw new Error(`ic_kpis month_idx=${monthIndex}: updated ${changed.length} rows`);
    }
    actualZoom[String(monthIndex)] = value;
  }

  return {
    applicants_total: rawApplicants.length,
    applicants_2026: target.length,
    inserted: insertedRows.length,
    persons_after: await personCount(env),
    actual_zoom: actualZoom,
  };
}

export async function handleConsultManagerIntake(
  env: Env
): Promise<{ count: number; detail: string }> {
  const summary = await syncConsultManagerIntake(env);
  return {
    count: summary.inserted,
    detail:
      `UTAGE 予約者 ${summary.applicants_total} 件のうち 2026 年 ${summary.applicants_2026} 件。` +
      `新規 ${summary.inserted} 件・ic_persons ${summary.persons_after} 件。` +
      `actual_zoom=${JSON.stringify(summary.actual_zoom)}`,
  };
}

export async function handleConsultManagerIntakeHttp(
  env: Env
): Promise<Response> {
  try {
    return Response.json({ ok: true, result: await syncConsultManagerIntake(env) });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
