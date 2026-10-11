import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { parseChanges } from "./haaku-ai-changes.js";
import { previewManagementChanges, applyManagementChanges } from "./haaku-ai-store.js";

/**
 * haAku plans are human decisions, never an AI inference committed as fact.
 * 1. preview: no writes; show exact field diffs and ID to the user
 * 2. apply: only after explicit approval, same change JSON, matching preview ID
 *
 * MCP permission/authentication remains with existing shia2n-mcp gateway.
 * We never expose a generic Firestore path or destructive delete action.
 */
function uidFor(env: Env): string {
  if (!env.NAOKI_UID || !env.FIREBASE_SA_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error("haAkuの認証済み保存先設定がありません。変更していません");
  }
  return env.NAOKI_UID;
}
const CHANGE_EXAMPLE = JSON.stringify([
  { kind: "phase", request_id: "phase-20261011-001",
    data: { title: "集客基盤の構築", purpose: "集客と記事制作の導線を確認できる",
      startDate: "2026-10-01", dueDate: "2026-10-31", projectId: "" } },
  { kind: "milestone", request_id: "mile-20261011-001",
    data: { title: "メンシプ集客導線を完成", criterion: "登録動線をテスト済み",
      dueDate: "2026-10-31", status: "doing",
      phaseId: "phase_phase-20261011-001", projectId: "" } },
]);
export function registerHaakuWriteTools(server: McpServer, env: Env): void {
  server.tool(
    "haAku__preview_management_changes",
    "haAkuの戦略（長期/中期/短期）・フェーズ・マイルストーン・週間コミットを最大12件まとめて仮計算する。"+
    "読取のみ。既存ID・重複・期間・状態・変更理由を検証し、変更前後の全差分、preview_id、保存先を返す。"+
    "必ず変更内容を本人に提示し承認を受けること。承認前にapplyは呼ばない。"+
    "更新対象はdata.recordId（戦略）またはdata.id（他）。省略すると新規作成。"+
    "新規IDは種類+request_idから決まり、同じchange set内の参照先として利用できる。"+
    "week_startは週間コミットのみ、月曜日の日付。現行Web画面と同じ保存欄を用い、別台帳は作らない。",
    {
      changes_json: z.string().min(2).max(45000).describe(
        "JSON配列。各要素{kind:'strategy|phase|milestone|weekly',request_id:'重複しない10〜70文字のID',data:{...},week_start?:'YYYY-MM-DD'}。"+
        "最大12件。未知の欄や型は拒否。例："+CHANGE_EXAMPLE
      ),
    },
    async args => {
      const ops=parseChanges(args.changes_json);
      const uid=uidFor(env);
      const token=await getFirestoreToken(env);
      return asMcpTextResult(await previewManagementChanges(fetch,token,uid,ops));
    }
  );
  server.tool(
    "haAku__apply_management_changes",
    "haAkuのプレビュー済み変更を、**本人が会話内で具体的な変更案を明示承認したときだけ**書き込む。"+
    "プレビューから変更案やデータが変わった場合、または30分を超えた場合は拒否。"+
    "Firestore read-write transactionで全変更を一括保存し、保存直後に再取得して一致確認。"+
    "削除・未確認の達成・戦略の自動確定はしない。通信失敗時は二重実行せず状況確認。"+
    "AIだけの判断、承認されていない案、資料の推測に対してconfirmed_by_user=trueを渡してはならない。",
    {
      changes_json: z.string().min(2).max(45000).describe(
        "previewに渡したJSONを変更せずそのまま指定。追加・削除・順序変更するとプレビュー不一致になる"
      ),
      preview_id: z.string().min(70).max(90).describe("直前のpreviewが返したpreview_idをそのまま渡す"),
      confirmed_by_user: z.boolean().describe(
        "本人が変更案全体を読み、明示的に承認した場合だけtrue。AIの推測や単なる会話は不可"
      ),
    },
    async args => {
      if(args.confirmed_by_user !== true) {
        throw new Error("本人が承認していないため書き込みを拒否しました");
      }
      const ops=parseChanges(args.changes_json);
      const uid=uidFor(env);
      const token=await getFirestoreToken(env);
      return asMcpTextResult(await applyManagementChanges(
        fetch,token,uid,ops,args.preview_id,args.confirmed_by_user
      ));
    }
  );
}
