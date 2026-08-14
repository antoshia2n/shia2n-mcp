/**
 * shia2n-mcp エントリーポイント v0.51.0（版の実物は version.ts の APP_VERSION を見る）
 *
 * v0.8.0：GET /taskmaster/tasks・/taskmaster/diag 追加
 * v0.9.0：taskmaster__list_tasks 追加
 * v0.10.0：sales_manager__get_revenue_summary 追加
 * v0.11.0：slack_post_message 追加
 * v0.12.0：/taskmaster/diag に Bearer 認証追加
 * v0.13.0：POST /taskmaster/tasks・taskmaster__add_task 追加
 * v0.14.0：/diag 公開診断エンドポイント追加
 * v0.15.0：content_os__list_posts / content_os__get_post / content_os__search_posts 追加
 * v0.16.0：POST /taskmaster/tasks/update・taskmaster__update_task / content_os__update_score 追加
 * v0.17.0：inbox_review_assist 追加
 * v0.18.0：haAku__get_kpi_progress / haAku__get_daily_report 追加
 * v0.19.0：knowledge_tag_suggest 追加
 * v0.20.0：Cron ネタ9本メール追加（依頼書：3194c8d4-3517-4ad9-b996-fe53ca9cfe71）
 * v0.21.0：taskmaster__create_project / taskmaster__delete_project 追加（依頼書：de27238b-8526-4529-9e7c-a26667d506e4）
 * v0.22.0：taskmaster__update_task に projectId / groupId 追加（依頼書：e3756a13-2c72-441d-a6cf-f04c5ee73788）
 * v0.23.0：mn__create_lesson_from_youtube 追加（学ぶくん A S2先行解凍）
 * v0.24.0：content_os__list_slots / content_os__fill_slot 追加（依頼書：3619c6c1-c439-817f-9533-ee9b661830f4）
 * v0.25.0：content_os__create_slot 追加（依頼書：3619c6c1-c439-8128-9de8-fb5da46c209b）
 * v0.26.0：会員管理くん Phase 3 ③ UTAGE ポーリング追加（POST /utage/backfill）
 * v0.26.1：cron を 1 本（0,30 * * * *）に統合（Free プラン 5 本上限対策）
 *          ネタメールは handler 内の UTC 時刻判定で既存と同時刻（UTC 18:00 / 22:00）発火
 * v0.27.0：UTAGE を MCP から REST API に切り替え（api.utage-system.com/v1）
 *          scheduled 発火直後ログ + エラー再 throw で Cron Events に失敗記録
 *          GET /utage/diag 診断エンドポイント追加（認証不要）
 * v0.28.0：会員管理くん Phase 3 ④ 自動写像適用 cron 追加（15,45 * * * *）
 *          controller.cron で分岐して handleAutoMappingCron を呼び出す
 *          既存 UTAGE ポーリング（0,30）とは別 cron で 15 分後に reconciliation 実行
 * v0.29.0：会員管理くん Phase 4 スコープ A の members__* 3 本追加
 *          members__search / members__get / members__update
 *          認証は MEMBERS_INTERNAL_TOKEN（sync-utage-batch 用の MEMBERS_INTERNAL_SECRET とは別 Secret）
 *          リスク吸収 3 点（PII 禁止 8 種 / preview モード / 1req=1 会員）は会員管理くん本体側で実装
 *          仕様確定 Decision：https://www.notion.so/3949c6c1c4398176805ae41019b5a6ec
 * v0.30.0：運用効率化パッケージ v1.0 実装（Decision 3959c6c1-c439-818b-b56d-ddce1d9fe776 / 2026-07-06）
 *          ① munikis__get_context ツール追加（起動時 Notion fetch 4〜5 回を 1 呼び出しに圧縮）
 *          ② 週次レビュー起動テキストの #01-戦略室 Slack 自動投稿 cron 追加
 *            既存 "0,30 * * * *" の日曜 00:00 UTC（= 日曜 09:00 JST）分岐に相乗り（cron trigger 追加なし）
 *          NOTION_TOKEN / SLACK_WEBHOOK_01 は既存 Secret を再利用（追加設定不要）
 * v0.32.0：ContentOS 改良 v1.2 F6。content_os__add_post / bulk_add_posts /
 *          list_accounts / update_post を追加。list_posts に account_id・status、
 *          list_slots / search_posts に account_id を追加
 * v0.31.0：運用効率化パッケージ v1.0 施策② の実装方式を変更
 *          （方針変更 Decision 3959c6c1-c439-81f9-9cac-e2dd3a93ac0d / 2026-07-06）
 *          Slack 自動投稿 cron を廃止：cron-weekly-review.ts 削除・
 *          scheduled ハンドラから日曜 00:00 UTC 分岐削除・handleWeeklyReviewCron import 削除
 *          代替として munikis__get_context のレスポンスに weekly_review_due フラグを追加
 *          （実装は munikis-client.ts 側）
 *          Naoki は「Google カレンダー繰返予定（日曜 09:00 JST）+ Claude 起動時フラグ」の
 *          二段構えで週次レビュー発火を管理する
 * v0.33.0：ネタ9本メールに入切スイッチ（NETA_MAIL_ENABLED）を追加
 *          Anthropic 側の残高切れで毎日 2 回（JST 03:00 / 07:00）失敗が続くため、
 *          Naoki の方針「一旦止める」を受けて既定を止まる側にする。
 *          NETA_MAIL_ENABLED が "1" のときだけ実行し、それ以外（未設定を含む）は
 *          失敗ではなく通常のログを残して静かに飛ばす。
 *          再開・停止は Cloudflare 側の Secret の入切だけででき、アップロード不要。
 *          現在の入切状態は GET /diag の switches.neta_mail で確認できる。
 * v0.34.0：自動で動くものの実行記録を追加（cron-log.ts）
 *          判断記録：https://www.notion.so/3b29c6c1c4398113bc59df5a566ea591
 *          Zeus 同期 / UTAGE ポーリング / ネタ9本メールの 3 つについて、
 *          いつ・成否・件数・失敗原因を KV に残す。見る場所は既存の 2 つ
 *          （GET /diag の last_runs と munikis__get_context の recent_runs）。
 *          Zeus は起動までしか関与しないため件数は null（件数は zeus-worker 側）。
 *          連絡ツールへの通知はこの版では残す（移行の間に異常を落とさないため）。
 * v0.35.0：連絡ツールへの異常通知を削除（第2便）
 *          判断記録：https://www.notion.so/3b29c6c1c4398113bc59df5a566ea591
 *          cron-utage-polling.ts の notifyDevSlack（呼び出し 2 か所と関数本体）を削除。
 *          UTAGE ポーリングは v0.34.0 で実行記録が動いていることを実機で確認済みのため、
 *          置き換え先が用意できてから外す順序になっている。
 *          あわせて、部分失敗のときに投げるエラーへ失敗したアカウントと理由を載せた。
 *          通知文にしか入っていなかった情報が、削除で失われるのを防ぐため。
 *          SLACK_WEBHOOK_03 の Secret 削除は Naoki 作業（この版の反映後）。
 * v0.36.0：連絡ツール（Slack）の名残を削除（第3便・Naoki 承認 2026-08-04）
 *          正本 Decision：Slack 完全廃止・申し送りルート再定義（2026-07-26）
 *          ① slack_post_message の道具を廃止（tools-slack.ts の import と登録を削除）。
 *            道具として残っていると、廃止済みの経路を他のチャットが使えてしまうため。
 *          ② 廃止済みの週次レビュー投稿（cron-weekly-review.ts）は v0.31.0 で
 *            「削除」と記録されていたが実物が残っていた。呼び出しは 0 か所。
 *          ①② のファイル本体の削除は Naoki が GitHub の画面で行う（アップロードでは消せないため）。
 *          Env の SLACK_WEBHOOK_01〜04 は点検画面が名前を参照しているため宣言だけ残す。
 * v0.37.0：点検画面から使っていない設定を外す（第4便）
 *          タスク：https://www.notion.so/3b19c6c1c43981a89d6adfb0e363e68d
 *          ① /diag の項目から SLACK_WEBHOOK_01〜04 を削除（diag.ts v0.17.0）。
 *          ② /utage/diag から SLACK_WEBHOOK_03 の項目を削除（handle-utage-diag.ts v1.1.0）。
 *          ③ Env の SLACK_WEBHOOK_01〜04 の宣言を削除（読む側が居なくなったため）。
 *          点検画面の 23 項目を全件、末端まで呼び出しを辿って確認した結果、
 *          読まれていないのはこの 4 件だけだった。他の 19 件はすべて現役。
 *          Cloudflare 側の Secret 4 本の削除は、この版の反映後に Naoki が行う。
 *          あわせて、冒頭の版表記（v0.34.0 のまま）と MCP サーバーの版（0.32.0 のまま）が
 *          実物とずれていたので、いずれも 0.37.0 にそろえた。
 * v0.38.0：haAku__update_goals 追加（把握くんの目標値を書き換える道具・2026-08-05）
 * v0.39.0：控えの失敗を外から読めるようにする（2026-08-06）
 *          2026-08-06 の初回実行が失敗し、対象 181 件のうち 40 件しか書けなかったが、
 *          理由が目録（R2）の中にしか無く、外から原因を判別できなかった。
 *          ① cron-backup.ts v1.1.0：失敗の理由を文言ごとに数え、実行記録の文面に
 *             「理由ごとの件数（上位3種）」「最後に書けた場所」「最初に失敗した場所」
 *             「取り切れていない表」を載せる。目録を外へ見せる口は作らない
 *             （表の名前が漏れるため）。
 *          ② munikis__backup_now 追加：控えを手で 1 回動かす。毎日 4 時を待たずに
 *             直したことの効き目を確かめられる。中身は自動実行と同じ処理を呼ぶだけ。
 * v0.40.0：控えを分けて取る（2026-08-06）
 *          v0.39.0 で理由が読めるようになり、原因が確定した。
 *          132 件すべてが「1 回の実行での外部呼び出しが多すぎる」で落ちていた。
 *          表ごとの問題ではなく、1 回の実行あたりの上限に当たっていた。
 *          ① cron-backup.ts v2.0.0：進み具合を KV に残し、JST 04:00 から 15 分おきに
 *             続きから処理する。締めは JST 06:45。そろった回だけ記録を残す
 *             （毎回残すと 5 件の枠が 1 日で埋まるため）。時間内に終わらなければ
 *             最後の回で失敗として記録する。
 *          ② 2 万件を超える表は .part2 .part3 … と分けて書き出す（audit_logs 対応）。
 *             1 つの塊にまとめないのは、大きな中身を一度に抱えると実行が落ちるため。
 *          ③ munikis__backup_now は「1 回で全部」から「1 回ぶん進める」に変更。
 *             finished が true になるまで繰り返し呼ぶ。restart で最初からやり直せる。
 *          cron 枠は増やしていない（既存の 2 本に相乗り）。設定の追加も不要。
 * v0.41.0：履歴の印が付いた 13 本を控えの対象から外す（2026-08-06）
 *          181 本の仕分けで、控えの大きさの 69% を履歴系 13 本が占めると分かった。
 *          控えの目的は「全部消えたときに事業を復旧できること」に絞られており、
 *          履歴系は対象外と決まっている。これはその実行。
 *          ① cron-backup.ts v2.1.0：EXCLUDED_TABLES の 13 本を対象から外す。
 *             表そのものは消さない。外した名前は目録に残す。
 *          ② 書き出した大きさを数え、目録と実行記録の文面に載せる。
 *             保管庫の画面を見に行かなくても 1 日分の大きさが分かるようにする。
 *          ③ 同じ日に前の版が書き出した外し対象の控えが残っていれば片づける。
 *             残すと使用量が減らず、外した効果が数字に出ないため。
 * v0.42.0：控えから戻す試しの道具を追加（2026-08-06）
 *          控えは取れているが一度も戻していない。戻せなければ取っている意味が無いので、
 *          実際に 1 本通して確かめられるようにする。
 *          munikis__restore_test：書き戻す先は「元の名前 + _restore_test」に固定。
 *          呼ぶ側から本番の表を指定できない作りにしてある。
 *          件数が 5000 を超える表は断る（1 回の実行での上限に当たるため）。
 * v0.43.0：起動のまとめ取得の取りこぼしを直す（2026-08-08）
 *          munikis-client.ts のみ変更。3 点。
 *          ① ページ送りが無く、Sessions は先頭 100 件、Decisions と Tasks は先頭 30 件しか
 *             見ていなかった。実物は 240 / 291 / 317 件。並べ替えは取ったあとに
 *             手元でやっていたため「直近 30 件」にもなっていなかった。
 *          ② 除外する状態の名前が実物と食い違っていた（Tasks は「破棄」ではなく「廃案」。
 *             Decisions に「完了」「破棄」は存在しない）。撤回を除く現行の見え方は変えていない。
 *          ③ 未完了の総数・担当別の内訳・呼び出したチャットの担当ぶんの一覧を返すようにした。
 *             起動のたびに担当で数え直す手作業をなくすため。
 * v0.44.0：版番号の置き場を 1 つにする（2026-08-08）
 *          それまで版番号は 2 か所にあった。ここ（道具の名乗り）と diag.ts（点検画面が
 *          返す値）で数え方が別で、点検画面には 0.18.0 と出ていた。実物より 25 古い。
 *          src/version.ts を新設し、どちらもそこを読む形にした。版を上げるときは
 *          version.ts の 1 行だけを書き換える。
 * v0.45.0：売上管理に月の売上を記録する口を追加（2026-08-09）
 *          依頼：https://www.notion.so/3b39c6c1c4398171997ad5fc5d8c8918
 *          sales_manager__record_monthly_revenue を追加。tools-sales-manager.ts のみ変更。
 *          書き先は売上管理側に新設した受け口 /api/sm-record で、合言葉が必須。
 *          既存の画面用の書き込み口には触れていない（画面は合言葉を持てないため）。
 *          触れる行は名前が「YYYY-MM 事業名（自動）」の形のものだけに縛ってあり、
 *          Naoki が手で入れた行には当たらない。設定の追加は無し
 *          （SALES_MANAGER_INTERNAL_SECRET を読み取りと共用する）。
 * v0.46.0：Buffer の反応の数字を ContentOS の成績へ戻す取り込みを毎日 1 回起動（2026-08-09）
 *          依頼：https://www.notion.so/3b59c6c1c439818c9224ed5c9bfab9b8
 *          ① cron-contentos-metrics.ts を新設。UTC 03:00（JST 12:00）の 1 回だけ、
 *             ContentOS の /api/internal/sync-buffer-metrics を叩く。
 *             本体は ContentOS 側にある（投稿の表を持っているのが向こうだけのため）。
 *             cron の枠は増やしていない（既存の 0,30 に相乗り）。
 *          ② content_os__sync_buffer_metrics を追加。手で 1 回動かして確かめる用。
 *          ③ cron-log.ts に contentos_metrics を足した。これで /diag の last_runs と
 *             munikis__get_context の recent_runs に自動で出る。
 *          設定の追加は無し（CONTENT_OS_API_BASE と CONTENT_OS_INTERNAL_SECRET を
 *          既存の読み書きと共用する）。Buffer の鍵は ContentOS 側にだけ置く。
 * v0.47.0：置き場が生きているかを 1 画面で見る口を追加（GET /place-check・place-check.ts 新設）
 *          タスク：https://www.notion.so/3b99c6c1c43981ea86cde8be9a14c1bf
 *          置き場の一覧（Systems）の全行を読み、本番の住所が入っている行を並べて叩き、
 *          名前と「開く／応答はあるが開かない／開かない／住所の登録が無い」を返す。
 *          住所の一覧はこのコードに持たず、毎回 Notion 側を読む（食い違いを作らないため）。
 *          対照として shia2n-mcp 自身の行を必ず見て、そこが開いていなければ
 *          結果全体を信頼できないと返す。
 *          1 回の実行で外へ出す呼び出しは 40 本で頭打ちにした（無料の枠は 50 本。
 *          2026-08-10 に Zeus の取り込みがこの上限で落ちているため）。
 * v0.48.0：置き場の点検の口を 2 回叩く形にした（place-check.ts）
 *          タスク：https://www.notion.so/3b99c6c1c4398107bbccf34015d25d69
 *          1 回目は HEAD、そこで 200 番台が返らなかった行だけ 2 回目に GET で確かめ直す。
 *          きっかけは記録くんで、画面は普通に出るのに HEAD にだけ 500 を返す作りだった。
 *          このままだと呼ぶたびに同じ確かめをやり直すことになる。
 *          外への呼び出しが上限に当たらないよう、叩く先を 30 本・確かめ直しを 12 本で
 *          頭打ちにした（最悪でも 一覧の取り込み 2 ＋ 30 ＋ 12 で 44 本・無料の枠は 50 本）。
 * v0.49.0：売上管理の住所の関門を機械から通れるようにした（2026-08-12）
 *          タスク：https://www.notion.so/3b69c6c1c43981d9b56cf08f01c633af
 *          売上管理（sales-manager.shia2n.jp）の手前に Cloudflare Access の関門を
 *          置くため、そこを通って呼ぶ側にサービス用の合言葉を載せる。
 *          ① src/cf-access.ts を新設。CF-Access-Client-Id と
 *             CF-Access-Client-Secret の 2 つを、両方そろっているときだけ見出しに載せる。
 *          ② tools-sales-manager.ts の取得 5 本（/api/sm-payments・sm-contracts・
 *             sm-singles・sm-businesses・sm-budgets）と書き込み 1 本（/api/sm-record）に
 *             その見出しを足した。売上管理側の受け口が見る合言葉（Authorization）は
 *             別物で、両方送る。
 *          ③ diag.ts の疎通確認でも、売上管理の行だけ合言葉を載せて叩く。
 *             載せないと、アプリが生きていてもログイン画面に跳ね返されて
 *             「開かない」と出るため。あわせて 2 つの設定の有無を点検の口に出した。
 *          関門がまだ無い住所へ送っても余分な見出しとして無視されるだけなので、
 *          先にこちらを反映し、動くことを見てから関門をかける順番が採れる。
 * v0.50.0：関門の合言葉の「形」を点検の口に出した（2026-08-12・diag.ts のみ変更）
 *          きっかけ：関門をかけたあと、設定は「あり」なのに機械が通れない状態になった。
 *          あり／なし だけでは、貼り付けのときに一部が欠けた値も「あり」に見えるため、
 *          値が悪いのか決まりが悪いのかを画面から切り分けられなかった。
 *          出すのは 文字数・末尾が .access か・前後の空白の有無 の 3 つだけで、
 *          値そのものは絶対に出さない（点検の口は認証なしで開けるため）。
 * v0.51.0：会員管理くんを叩く 6 本にも関門の合言葉を載せた（2026-08-13）
 *          タスク：https://www.notion.so/3b99c6c1c439817f9d1de0db7d444f08
 *          会員管理くん（members.shia2n.jp）の手前に Cloudflare Access の関門を
 *          置くため、そこを通って呼ぶ側にサービス用の合言葉を載せる。
 *          売上管理（v0.49.0）と同じ形で、合言葉は同じ 2 つを使い回す
 *          （CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET・追加の設定は要らない）。
 *          ① cf-access.ts が受け取る型を、必要な 2 つだけを持つ形に広げた。
 *             tools-members.ts は自分用の小さな型を持っており Env を渡せなかったため。
 *          ② 会員管理くんを叩く 6 本すべてに見出しを足した。
 *             30 分ごとの読者の取り込み（cron-utage-polling → sync-utage-batch）／
 *             15 分と 45 分の自動写像（cron-auto-mapping → apply-auto-mapping-batch）／
 *             取り込み直しの口（handle-utage-backfill → sync-utage-batch）／
 *             members__search・members__get・members__update の 3 本／
 *             点検の口（handle-utage-diag の会員管理くんへの疎通確認）。
 *             会員管理くん側の受け口が見る合言葉（Authorization）は別物で、両方送る。
 *          関門がまだ無い住所へ送っても余分な見出しとして無視されるだけなので、
 *          先にこちらを反映し、動くことを見てから関門をかける順番が採れる。
 */
import { APP_VERSION } from "./version.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { registerHighShinTools } from "./tools.js";
import { registerHighShinPhase3Tools } from "./tools-high-shin-phase3.js";
import { registerZeusTools } from "./tools-zeus.js";
import { registerZeusV2Tools } from "./tools-zeus-v2.js";
import { registerFormKunTools } from "./tools-form-kun.js";
import { registerPayKunTools } from "./tools-pay-kun.js";
import { registerTaskmasterTools } from "./tools-taskmaster.js";
import { registerSalesManagerTools } from "./tools-sales-manager.js";
import { registerContentOsTools } from "./tools-content-os.js";
import { registerInboxReviewTools } from "./tools-inbox-review.js";
import { registerHaakuTools } from "./tools-haaku.js";
import { registerKnowledgeTagTools } from "./tools-knowledge-tag.js";
import { registerManabuTools } from "./tools-manabu.js";
import { registerShiaraboTools } from "./tools-shiarabo.js";
import { registerMembersTools } from "./tools-members.js";
import { registerMunikisTools } from "./tools-munikis.js";
import { AuthHandler } from "./auth-handler.js";
import { handleTaskmasterTasks, handleTaskmasterAddTask, handleTaskmasterUpdateTask, handleTaskmasterCreateProject, handleTaskmasterDeleteProject, handleTaskmasterDiag } from "./taskmaster.js";
import { handleDiag } from "./diag.js";
import { handlePlaceCheck } from "./place-check.js";
import { handleScheduled } from "./cron-neta-mail.js";
import { handleUtagePolling } from "./cron-utage-polling.js";
import { handleUtageBackfill } from "./handle-utage-backfill.js";
import { handleUtageDiag } from "./handle-utage-diag.js";
import { handleAutoMappingCron } from "./cron-auto-mapping.js";
import { runAndRecord, recordSkipped } from "./cron-log.js";
import { handleZeusSync } from "./cron-zeus-sync.js";
import { handleContentOsMetricsSync } from "./cron-contentos-metrics.js";
import { runBackupSlot } from "./cron-backup.js";
import { registerRestoreTools } from "./tools-restore.js";

export interface Env {
  // Core
  MCP_SERVER_SECRET: string;
  MCP_DEFAULT_USER_ID: string;
  // OAuth
  OAUTH_KV: KVNamespace;
  // データの控えの置き場（R2）。wrangler.jsonc の r2_buckets で結び付ける
  BACKUP_BUCKET: R2Bucket;
  // High-Shinくん
  HIGH_SHIN_API_BASE: string;
  HIGH_SHIN_INTERNAL_SECRET: string;
  // Zeus
  ZEUS_API_BASE: string;
  ZEUS_INTERNAL_SECRET: string;
  ZEUS_EXTERNAL_SECRET: string;
  // Zeus 同期 Worker（zeus-worker）
  // 2026-08-03：Cron Triggers 上限のため zeus-worker 側 cron を廃止し、
  // 本 Worker の 0,30 cron（UTC 18:00 分岐）から HTTP で起動する。
  ZEUS_WORKER_URL: string;
  ZEUS_WORKER_SECRET: string;
  // Form-kun
  FORM_KUN_API_BASE: string;
  FORM_KUN_INTERNAL_SECRET: string;
  // Pay-kun
  PAY_KUN_API_BASE: string;
  PAY_KUN_INTERNAL_SECRET: string;
  // ContentOS
  CONTENT_OS_API_BASE: string;
  CONTENT_OS_INTERNAL_SECRET: string;
  // TaskMaster / haAku（Firestore）
  FIREBASE_SA_EMAIL: string;
  FIREBASE_SA_PRIVATE_KEY: string;
  NAOKI_UID: string;
  // Sales Manager
  SALES_MANAGER_API_BASE: string;
  // 2026-08-03：Sales Manager の取得口の合言葉（この用途で新規作成した Secret）。
  // 既存の合言葉は使い回さない（既存の呼び出し元を壊さないため）。
  // 未設定のときは見出しを付けずに従来どおり取得する（移行期間中に止めないため）。
  SALES_MANAGER_INTERNAL_SECRET?: string;
  // 2026-08-12 追加：Cloudflare Access（入口の関門）を機械から通るための
  // サービス用の合言葉。売上管理の住所の手前に関門を置いたため、
  // ブラウザのログインを通らない shia2n-mcp からの呼び出しにはこれが要る。
  // 2 つそろっているときだけ見出しを付ける（片方だけでは通れないため）。
  // 秘密の値なので画面側の Secret で管理する（wrangler.jsonc には書かない）。
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  // v0.17.0 追加
  NOTION_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  // v0.20.0 追加（Cron ネタ9本メール）
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  RESEND_TO_EMAIL: string;
  // 2026-08-04 追加（ネタ9本メールの入切スイッチ）。
  // "1" のときだけ送信処理を実行する。未設定・空・"1" 以外はすべて停止。
  // 既定を停止側にしているのは、止めたい状態が既定であるべきだから
  // （Secret が消えたり移行に失敗しても、勝手に再開して失敗が再発しない）。
  // 値そのものは秘密ではないが、画面のプレーンテキスト変数は wrangler.jsonc の
  // vars を含むデプロイで上書きされて消えるため、Secret 側で管理する。
  NETA_MAIL_ENABLED?: string;
  // v0.23.0 追加（学ぶくん A）
  YOUTUBE_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // v0.26.0 追加（会員管理くん Phase 3 ③ UTAGE ポーリング）
  UTAGE_MCP_URL: string;              // https://api.utage-system.com/mcp（v0.27.0 で未使用・後方互換のみ）
  UTAGE_MCP_TOKEN: string;            // v0.27.0 で暫定フォールバック（UTAGE_API_KEY が未設定時のみ）
  MEMBERS_API_BASE: string;           // https://members.shia2n.jp（v0.28.0 で auto-mapping cron でも再利用）
  MEMBERS_INTERNAL_SECRET: string;    // 会員管理くん Cloudflare Secret と同値（v0.28.0 で auto-mapping cron でも再利用）
  // v0.27.0 追加（UTAGE REST API 移行）
  UTAGE_API_KEY: string;              // UTAGE 管理画面で発行した REST API キー
  UTAGE_API_BASE: string;             // https://api.utage-system.com/v1（wrangler vars で設定）
  // v0.29.0 追加（会員管理くん Phase 4 スコープ A members__* 3 本）
  MEMBERS_INTERNAL_TOKEN: string;     // 会員管理くん Cloudflare Pages 側の MEMBERS_INTERNAL_TOKEN と同値
                                      // MEMBERS_INTERNAL_SECRET とは別 Secret（スコープ分離：漏洩時の被害範囲最小化）
}

// ─────────────────────────────────────────────
// データの控えの発火時刻（2026-08-06 v0.40.0）
//   JST 04:00 に開始し、15 分おきに続きを処理して JST 06:45 で締める。
//   UTC では 19:00 〜 21:45。cron の枠は増やさず既存の 2 本に相乗りする。
// ─────────────────────────────────────────────
function isBackupSlot(utcHour: number, utcMinute: number): boolean {
  if (utcHour === 19 || utcHour === 20) return true;
  if (utcHour === 21 && utcMinute <= 45) return true;
  return false;
}

function isBackupStart(utcHour: number, utcMinute: number): boolean {
  return utcHour === 19 && utcMinute === 0;
}

function isBackupLastChance(utcHour: number, utcMinute: number): boolean {
  return utcHour === 21 && utcMinute === 45;
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "shia2n-mcp", version: APP_VERSION });
  registerHighShinTools(server, env);
  registerHighShinPhase3Tools(server, env);
  registerZeusTools(server, env);
  registerZeusV2Tools(server, env);
  registerFormKunTools(server, env);
  registerPayKunTools(server, env);
  registerTaskmasterTools(server, env);
  registerSalesManagerTools(server, env);
  registerContentOsTools(server, env);
  registerInboxReviewTools(server, env);
  registerHaakuTools(server, env);
  registerKnowledgeTagTools(server, env);
  registerManabuTools(server, env);
  registerShiaraboTools(server, env);
  registerMembersTools(server, env);
  registerMunikisTools(server, env);
  registerRestoreTools(server, env);
  return server;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization") ?? "";
  return (
    authHeader.startsWith("Bearer ") &&
    timingSafeEqual(authHeader.slice(7), env.MCP_SERVER_SECRET)
  );
}

const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const server = createMcpServer(env);
    return createMcpHandler(server, { route: "/mcp" })(request, env, ctx);
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute:   "/mcp",
  apiHandler: mcpApiHandler,
  defaultHandler: AuthHandler,
  authorizeEndpoint:          "/authorize",
  tokenEndpoint:              "/token",
  clientRegistrationEndpoint: "/register",
  resolveExternalToken: async ({ token, env: rawEnv }) => {
    const env = rawEnv as Env;
    if (!env.MCP_SERVER_SECRET) return null;
    if (!timingSafeEqual(token, env.MCP_SERVER_SECRET)) return null;
    return {
      userId: env.MCP_DEFAULT_USER_ID,
      props:  { userId: env.MCP_DEFAULT_USER_ID },
    };
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
      });
    }

    if (url.pathname === "/diag" && request.method === "GET") {
      return handleDiag(request, env);
    }

    // v0.47.0：置き場が生きているかを 1 画面で見る口（認証不要・秘密の値は返さない）
    // タスク：https://www.notion.so/3b99c6c1c43981ea86cde8be9a14c1bf
    if (url.pathname === "/place-check" && request.method === "GET") {
      return handlePlaceCheck(request, env);
    }

    if (url.pathname.startsWith("/taskmaster/")) {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/taskmaster/diag" && request.method === "GET") {
        return handleTaskmasterDiag(request, env);
      }
      if (url.pathname === "/taskmaster/tasks" && request.method === "GET") {
        return handleTaskmasterTasks(request, env);
      }
      if (url.pathname === "/taskmaster/tasks" && request.method === "POST") {
        return handleTaskmasterAddTask(request, env);
      }
      if (url.pathname === "/taskmaster/tasks/update" && request.method === "POST") {
        return handleTaskmasterUpdateTask(request, env);
      }
      if (url.pathname === "/taskmaster/projects" && request.method === "POST") {
        return handleTaskmasterCreateProject(request, env);
      }
      if (url.pathname === "/taskmaster/projects/delete" && request.method === "POST") {
        return handleTaskmasterDeleteProject(request, env);
      }
      return Response.json({ error: "Not Found" }, { status: 404 });
    }

    // v0.27.0：UTAGE 診断エンドポイント（認証不要・秘密情報は返さない）
    if (url.pathname === "/utage/diag" && request.method === "GET") {
      return handleUtageDiag(env);
    }

    // v0.26.0：UTAGE 手動バックフィル用エンドポイント
    if (url.pathname === "/utage/backfill" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handleUtageBackfill(request, env);
    }

    return oauthProvider.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // v0.31.0：cron は 2 本（"0,30 * * * *" と "15,45 * * * *"）
    // controller.cron で分岐する（Free プラン 5 本上限内・現状 2 本使用）。
    // v0.30.0 で追加した週次レビュー Slack 投稿は v0.31.0 で廃止済み（方針変更 Decision による）。
    // 週次レビュー未起票検知は munikis__get_context の weekly_review_due フラグに移行。
    const scheduledDate = new Date(controller.scheduledTime);
    const utcHour = scheduledDate.getUTCHours();
    const utcMinute = scheduledDate.getUTCMinutes();

    // 発火直後ログ（Cron Events / Observability に必ず記録される）
    console.log(
      "[scheduled] fired",
      JSON.stringify({
        cron: controller.cron,
        scheduled_time: scheduledDate.toISOString(),
        utc_hour: utcHour,
        utc_minute: utcMinute,
      })
    );

    const tasks: Promise<void>[] = [];

    if (controller.cron === "0,30 * * * *") {
      // 既存：UTAGE ポーリング（毎回 30 分ごと）
      tasks.push(
        runAndRecord(env, "utage_polling", async () => {
          const summary = await handleUtagePolling(env);
          return {
            count: summary.readers_total,
            detail: `対象アカウント ${summary.accounts} 件・読者 ${summary.readers_total} 件を送信`,
          };
        })
      );

      // 既存：ネタ9本メール（UTC 18:00 / 22:00 のみ発火）
      // 2026-08-04：NETA_MAIL_ENABLED が "1" のときだけ実行する。
      // それ以外（未設定を含む）は失敗扱いにせず、通常のログを残して飛ばす。
      // throw しないのは、止めている状態を Cron Events の失敗として
      // 記録し続けると、本当の失敗が埋もれるため。
      if (utcMinute === 0 && (utcHour === 18 || utcHour === 22)) {
        if (env.NETA_MAIL_ENABLED === "1") {
          tasks.push(
            runAndRecord(env, "neta_mail", async () => {
              await handleScheduled(env);
              return { count: 9, detail: "ネタ9本のメールを送信" };
            })
          );
        } else {
          // 止めていることも記録に残す。記録が無いと「壊れて動いていない」と
          // 見分けが付かなくなるため。
          tasks.push(
            recordSkipped(
              env,
              "neta_mail",
              "入切スイッチが入っていないため送っていません（意図的な停止）"
            )
          );
          console.log(
            "[scheduled] neta-mail skipped",
            JSON.stringify({
              reason: "NETA_MAIL_ENABLED is not \"1\"",
              utc_hour: utcHour,
            })
          );
        }
      }

      // 2026-08-03：Zeus 同期の起動（UTC 18:00 = JST 03:00 のみ発火）
      // Cron Triggers が Free プラン上限 5 本で埋まっており zeus-worker 側の
      // cron を登録できないため、cron 枠を増やさずここから HTTP で起動する。
      if (utcMinute === 0 && utcHour === 18) {
        tasks.push(
          runAndRecord(env, "zeus_sync", async () => {
            // 2026-08-14：取り込み元 5 つを 1 つずつ起動する形に変えた。
            // 何本起動できたかは handleZeusSync が返す。何件入ったかは
            // zeus-worker が自分で書く zeus_import に 1 本ごとに残る。
            return await handleZeusSync(env);
          })
        );
      }

      // 2026-08-09：Buffer の反応の数字を ContentOS の成績へ戻す
      // （UTC 03:00 = JST 12:00 のみ発火）
      // Buffer 側の数字は 1 日 1 回まとめて更新される（2026-08-09 の実測では
      // JST 10:52）。その後に取りに行く時刻として正午を選んだ。
      // Zeus 同期（JST 03:00）・データの控え（JST 04:00〜06:45）とは重ならない。
      if (utcMinute === 0 && utcHour === 3) {
        tasks.push(
          runAndRecord(env, "contentos_metrics", async () => {
            return await handleContentOsMetricsSync(env);
          })
        );
      }

      // 2026-08-05：データの控え（UTC 19:00 = JST 04:00 に開始）
      // Zeus 同期（JST 03:00）の 1 時間後に置く。同じ時刻に重ねると、
      // どちらの不調で遅れているのか分からなくなるため。
      // cron 枠は増やさず、既存の 0,30 の枠に相乗りする。
      //
      // 2026-08-06（v0.40.0）：1 回で全部やると外部呼び出しの上限に当たるため、
      // JST 04:00 〜 06:45 の 15 分おきの発火で続きから処理する。
      // 記録が残るのは、そろった回か、最後の回（JST 06:45）だけ。
      if (isBackupSlot(utcHour, utcMinute)) {
        tasks.push(
          runBackupSlot(
            env,
            isBackupStart(utcHour, utcMinute),
            isBackupLastChance(utcHour, utcMinute)
          ).then(() => undefined)
        );
      }
    } else if (controller.cron === "15,45 * * * *") {
      // v0.28.0：会員管理くん Phase 3 ④ 自動写像適用 reconciliation
      // UTAGE ポーリング（0,30）の 15 分後に走ることで payment_status 変更を反映
      tasks.push(handleAutoMappingCron(env));

      // 2026-08-06（v0.40.0）：控えの続き。15 分おきに進めたいので、
      // こちらの枠でも同じ判定で呼ぶ。開始は 0,30 側の JST 04:00 のみ。
      if (isBackupSlot(utcHour, utcMinute)) {
        tasks.push(
          runBackupSlot(
            env,
            isBackupStart(utcHour, utcMinute),
            isBackupLastChance(utcHour, utcMinute)
          ).then(() => undefined)
        );
      }
    } else {
      // 想定外の cron が来た場合はログのみ（fail しない）
      console.warn(
        "[scheduled] unknown cron",
        JSON.stringify({ cron: controller.cron })
      );
    }

    // エラーを握りつぶさず再 throw して Cron Events に失敗記録
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((result) => result.status === "rejected");

    if (failed.length > 0) {
      console.error(
        "[scheduled] failed",
        JSON.stringify({
          cron: controller.cron,
          failed_count: failed.length,
          results: results.map((result) =>
            result.status === "rejected"
              ? {
                  status: "rejected",
                  reason:
                    result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                }
              : { status: "fulfilled" }
          ),
        })
      );
      throw new Error(`scheduled tasks failed: ${failed.length}/${results.length}`);
    }

    console.log(
      "[scheduled] completed",
      JSON.stringify({
        cron: controller.cron,
        task_count: tasks.length,
      })
    );
  },
};
