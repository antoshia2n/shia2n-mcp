import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asMcpTextResult } from "./app-client.js";
import type { Env } from "./index.js";
import { getFirestoreToken } from "./taskmaster.js";
import { parseChanges, assertWeekStart } from "./haaku-ai-changes.js";
import { previewManagementChanges, applyManagementChanges, readSnapshot } from "./haaku-ai-store.js";
import { managementWriteAudit } from "./haaku-ai-audit.js";
import { issueHumanApproval } from "./haaku-human-approval.js";

/**
 * haAku plans are human decisions, never an AI inference committed as fact.
 * 1. preview: no business changes; issue a one-time approval request for the haAku browser
 * 2. apply: only after the Firebase-authenticated owner approves in the browser
 *
 * MCP permission/authentication remains with existing shia2n-mcp gateway.
 * We never expose a generic Firestore path. The only delete is kind "milestone_delete" (v1.11.0),
 * which goes through the same preview -> browser approval -> apply flow and keeps the deleted content in aiChanges.
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
    "業務データには書かず、既存ID・重複・期間・状態・変更理由を検証し、変更前後の全差分、preview_id、保存先を返す。"+
    "本人確認用の承認申請文書は別途1件作る。approval_urlをhaAkuにログインした本人が開いて承認する。"+
    "更新対象はdata.recordId（戦略）またはdata.id（他）。省略すると新規作成。"+
    "新規IDは種類+request_idから決まり、同じchange set内の参照先として利用できる。"+
    "week_startは週間コミットのみ、月曜日の日付。現行Web画面と同じ保存欄を用い、別台帳は作らない。"+
    "取り組み（kind:'initiative'・2026年の13の取り組み）は data.initiativeNo（01〜99）で特定し、無ければ新規・あれば改訂（版が1つ増える。改訂には reason が必要。省いた欄は前の版のまま）。"+
    "欄：initiativeNo・name・stage（整える／時間を作る／構築する）・overview（全体像）・ideals・conditions・kpis・approaches・plans・obstacles（この6つはJSONの文字列で [{\"text\":\"本文\",\"theme\":\"親テーマ（任意）\"}]・40項目まで）・"+
    "progress（進捗・空可）・linkedMilestoneIds・linkedKpiIds（結ぶマイルストーンとKPIのIDの配列をJSONの文字列で・存在しないIDは断る）・reason。"+
    "taskmasterProjectId（組にする TaskMaster のプロジェクトの id・空文字か null で外す・省くと前の版のまま）。TaskMaster に無い id・status が active でないプロジェクトは断る。1 つのプロジェクトは 1 つの取り組みにだけで、束を当て終えた形で確かめる（同じ束で A から外して B に付けられる）。"+
    "マイルストーンの前は data.dependsOnIds（前のマイルストーンIDの配列をJSONの文字列で・0〜10件・存在しないID・自分・循環・重複は断る）で複数持てる。古い dependsOn には配列の1つ目が自動で入る（両方渡して1つ目が違えば断る）。"+
    "マイルストーンを消すときは kind:'milestone_delete'・data:{id,reason}（理由は必須）。ほかのマイルストーンの前になっているもの・タスクが結ばれているもの・戦略が参照しているもの・重点に選ばれているものは断る。"+
    "結んでいる取り組みからは自動で外し、その取り組みの版を1つ上げる。消す前の中身はロードマップの書き込み記録（aiChanges）に残る。",
    {
      changes_json: z.string().min(2).max(45000).describe(
        "JSON配列。各要素{kind:'strategy|phase|milestone|weekly|initiative|milestone_delete',request_id:'重複しない10〜70文字のID',data:{...},week_start?:'YYYY-MM-DD'}。"+
        "最大12件。未知の欄や型は拒否。例："+CHANGE_EXAMPLE
      ),
    },
    async args => {
      const ops=parseChanges(args.changes_json);
      const uid=uidFor(env);
      const token=await getFirestoreToken(env);
      const preview=await previewManagementChanges(fetch,token,uid,ops);
      const approval=await issueHumanApproval(fetch,token,uid,preview);
      return asMcpTextResult({
        ...preview,...approval,
        note:"業務データ変更0件。Firestoreに承認申請の記録を1件作りました。承認はhaAkuのブラウザ画面で行ってください。",
      });
    }
  );
  server.tool(
    "haAku__apply_management_changes",
    "haAkuのプレビュー済み変更を、**haAkuにログインした本人がブラウザの承認画面で承認した場合だけ**書き込む。"+
    "チャット上の承認・AIから渡された真偽値では承認にならない。"+
    "プレビューから変更案やデータが変わった場合、または30分を超えた場合は拒否。"+
    "Firestore read-write transactionで全変更を一括保存し、保存直後に再取得して一致確認。"+
    "削除は kind:milestone_delete を本人が承認したときだけ。未確認の達成・戦略の自動確定はしない。通信失敗時は二重実行せず状況確認。"+
    "承認申請は業務データの一括トランザクションと同時に消費し、再利用できない。",
    {
      changes_json: z.string().min(2).max(45000).describe(
        "previewに渡したJSONを変更せずそのまま指定。追加・削除・順序変更するとプレビュー不一致になる"
      ),
      preview_id: z.string().min(70).max(90).describe("直前のpreviewが返したpreview_idをそのまま渡す"),
      approval_id: z.string().uuid().describe(
        "previewが返したapproval_id。haAkuのログイン済み承認画面で確定されるまで書き込めません"
      ),
    },
    async args => {
      const ops=parseChanges(args.changes_json);
      const uid=uidFor(env);
      const token=await getFirestoreToken(env);
      return asMcpTextResult(await applyManagementChanges(
        fetch,token,uid,ops,args.preview_id,args.approval_id
      ));
    }
  );
  server.tool(
    "haAku__get_management_write_audit",
    "AIがhaAkuの戦略・取り組み・フェーズ・マイルストーン・週間コミットへ承認付きで保存した記録を取得する。"+
    "確認した対象ID・操作時刻・改訂理由と件数を返す読み取り専用の診断口。"+
    "週間コミットはweek_start（月曜日）を指定したときだけ、その週の履歴を含める。"+
    "未登録と取得失敗を区別する。ブラウザから手作業で変更したものはAIの更新件数へ含めない。",
    {
      week_start: z.string().optional().describe(
        "読みたい週間コミットの週初め月曜日 YYYY-MM-DD。省略時は週間履歴を除外"
      ),
    },
    async args => {
      if(args.week_start)assertWeekStart(args.week_start);
      const uid=uidFor(env),token=await getFirestoreToken(env);
      const keys=["os_roadmap_v1","os_strategy_records_v1","os_initiatives_v1",
        ...(args.week_start?["os_weekly_commits_v1_"+args.week_start]:[])];
      const snap=await readSnapshot(fetch,token,uid,keys);
      return asMcpTextResult(managementWriteAudit(snap.store,args.week_start));
    }
  );

}
