import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPayKunInternalApi, asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";

/**
 * Pay-kun 用のツールを登録する。
 * 各ツールは Pay-kun 本体の /api/internal/* を薄くラップする。
 *
 * 命名規約：`pay_kun__<action>`（ダブルアンダースコアでアプリ名と機能を分離）
 *
 * 【PAY_KUN_SPEC.md §3 との対応】
 * - 読み取り系（list/get/search）はフラット送信
 * - get-product は product_id → id に変換
 * - 書き込み系（create/update/deactivate draft）は payload 入れ子に変換
 *   create:     { user_id, payload: { name, payment_status, plan_key?, price? } }
 *   update:     { user_id, target_id, payload: { name?, plan_key?, payment_status?, price? } }
 *   deactivate: { user_id, target_id }
 * - request-approval はフラット送信（pending_action_id）
 */
export function registerPayKunTools(server: McpServer, env: Env): void {
  // ─── 1. pay_kun__list_products ────────────────────────────────────────
  server.tool(
    "pay_kun__list_products",
    "Pay-kun に登録されている商品マスタ（pay_products）の一覧を取得する。商品名・プランキー・価格・payment_status・有効/無効フラグを確認するときに使う。戻り値: { products: [{id, name, plan_key, payment_status, price, active, created_at, updated_at}], count }。",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("最大取得件数（既定50、上限100）"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("取得開始位置（ページネーション用、既定0）"),
      active_only: z
        .boolean()
        .optional()
        .describe("有効商品のみ取得するか（既定false＝全件。true にすると active=true の商品のみ返す）"),
    },
    async (args) => {
      const result = await callPayKunInternalApi(env, "list-products", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 2. pay_kun__get_product ──────────────────────────────────────────
  server.tool(
    "pay_kun__get_product",
    "指定した商品ID の商品マスタ詳細を取得する。pay_kun__list_products で id を確認してから使う。戻り値: { product: {id, name, plan_key, payment_status, price, active, created_at, updated_at} }。",
    {
      product_id: z
        .string()
        .describe("取得する商品のID（必須）"),
    },
    async (args) => {
      // Pay-kun は { user_id, id } を期待する（product_id → id に変換）
      const result = await callPayKunInternalApi(env, "get-product", {
        id: args.product_id,
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 3. pay_kun__search_by_status ────────────────────────────────────
  server.tool(
    "pay_kun__search_by_status",
    "payment_status で商品を絞り込んで取得する。shr-webhook の決済処理と連携するステータス（free/pending/basic/monitor/premium）ごとに商品を確認するときに使う。戻り値: { products: [{id, name, plan_key, payment_status, price, active}], count, payment_status }。",
    {
      payment_status: z
        .enum(["free", "pending", "basic", "monitor", "premium"])
        .describe("絞り込む payment_status（必須）。free=無料、pending=決済待ち、basic=ベーシック、monitor=モニター、premium=プレミアム"),
    },
    async (args) => {
      const result = await callPayKunInternalApi(env, "search-by-status", args);
      return asMcpTextResult(result);
    }
  );

  // ─── 4. pay_kun__create_product_draft ────────────────────────────────
  server.tool(
    "pay_kun__create_product_draft",
    "新しい商品マスタの作成を「下書き」として登録する。この時点では pay_pending_actions に INSERT されるだけで pay_products は変更されない。実際の作成は pay_kun__request_approval で承認URLを発行し、Naokiが承認画面で確認・承認して初めて実行される。戻り値: { pending_action_id, preview_token, action_type: 'create', payload, expires_at }。",
    {
      name: z
        .string()
        .describe("商品名（必須）"),
      plan_key: z
        .string()
        .optional()
        .describe("プランキー（英数字とハイフンのみ。例: basic-monthly, premium-annual）"),
      payment_status: z
        .enum(["free", "pending", "basic", "monitor", "premium"])
        .describe("この商品に紐づく payment_status（必須）"),
      price: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("価格（円、整数。無料の場合は0または省略）"),
      expires_hours: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("承認URLの有効時間（時間、既定24）"),
    },
    async (args) => {
      // Pay-kun は { user_id, payload: { name, payment_status, ... } } を期待する
      const { expires_hours, ...payloadFields } = args;
      const result = await callPayKunInternalApi(env, "create-product-draft", {
        payload: payloadFields,
        ...(expires_hours !== undefined ? { expires_hours } : {}),
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 5. pay_kun__update_product_draft ────────────────────────────────
  server.tool(
    "pay_kun__update_product_draft",
    "既存商品マスタの変更を「下書き」として登録する。この時点では pay_pending_actions に INSERT されるだけで pay_products は変更されない。変更したいフィールドだけ渡せばよい（省略したフィールドは変更されない）。実際の変更は pay_kun__request_approval で承認URLを発行し、Naokiが承認画面で確認・承認して初めて実行される。戻り値: { pending_action_id, preview_token, action_type: 'update', target_id, target_name, payload, expires_at }。",
    {
      product_id: z
        .string()
        .describe("変更する商品のID（必須）"),
      name: z
        .string()
        .optional()
        .describe("新しい商品名（変更する場合のみ）"),
      plan_key: z
        .string()
        .optional()
        .describe("新しいプランキー（変更する場合のみ）"),
      payment_status: z
        .enum(["free", "pending", "basic", "monitor", "premium"])
        .optional()
        .describe("新しい payment_status（変更する場合のみ）"),
      price: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("新しい価格（円、整数。変更する場合のみ）"),
      expires_hours: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("承認URLの有効時間（時間、既定24）"),
    },
    async (args) => {
      // Pay-kun は { user_id, target_id, payload: { ...変更フィールド } } を期待する
      const { product_id, expires_hours, ...payloadFields } = args;
      // payloadFields が空（変更なし）の場合もそのまま渡す
      const result = await callPayKunInternalApi(env, "update-product-draft", {
        target_id: product_id,
        payload: payloadFields,
        ...(expires_hours !== undefined ? { expires_hours } : {}),
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 6. pay_kun__deactivate_product_draft ────────────────────────────
  server.tool(
    "pay_kun__deactivate_product_draft",
    "既存商品マスタの無効化（active=false）を「下書き」として登録する。削除ではなく論理無効化のため、承認後もデータは残り shr-webhook の参照には影響しない。実際の無効化は pay_kun__request_approval で承認URLを発行し、Naokiが承認画面で確認・承認して初めて実行される。戻り値: { pending_action_id, preview_token, action_type: 'deactivate', target_id, target_name, expires_at }。",
    {
      product_id: z
        .string()
        .describe("無効化する商品のID（必須）"),
      expires_hours: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("承認URLの有効時間（時間、既定24）"),
    },
    async (args) => {
      // Pay-kun は { user_id, target_id } を期待する（product_id → target_id に変換）
      const { product_id, expires_hours } = args;
      const result = await callPayKunInternalApi(env, "deactivate-product-draft", {
        target_id: product_id,
        ...(expires_hours !== undefined ? { expires_hours } : {}),
      });
      return asMcpTextResult(result);
    }
  );

  // ─── 7. pay_kun__request_approval ────────────────────────────────────
  server.tool(
    "pay_kun__request_approval",
    "pay_kun__create_product_draft / update_product_draft / deactivate_product_draft で登録した pending_action を承認URLとして発行する。NaokiがURLをクリック→内容確認→「承認して実行」ボタン押下で初めて pay_products が変更される。AIは承認URLを発行した後、そのURLをNaokiに提示して操作を待つこと。戻り値: { pending_action_id, preview_token, preview_url, action_type, expires_at }。",
    {
      pending_action_id: z
        .string()
        .describe("承認対象のアクションID（pay_kun__create/update/deactivate_product_draft の戻り値 pending_action_id、必須）"),
    },
    async (args) => {
      const result = await callPayKunInternalApi(env, "request-approval", args);
      return asMcpTextResult(result);
    }
  );
}
