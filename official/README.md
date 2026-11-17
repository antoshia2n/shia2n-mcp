# shia2n-mcp-official（外向けの MCP の窓口）

生徒・ゲストの AI に見える道具を、その人の権利で使える道具だけにする窓口。
Naoki 用の窓口は今の shia2n-mcp（このリポジトリの根）のまま。

## 決まり

| 何を | どう |
|---|---|
| つなげる人 | 会員の台帳にいて、開くもの（member_access の target）に `mcp_official` がある人 |
| 見える道具 | プログラムの名簿（src/tools.ts）と、開くものの `mcp:道具の名前` の両方に載っているものだけ |
| 使うとき | その場で権利を取り直し、まだ使えるときだけ動かす |
| 新しいプラン | member_access に「プランの権利 × mcp_official」と「プランの権利 × mcp:道具の名前」を足すだけ |
| 道具を足す | src/tools.ts に 1 つ足す。中身はつないだ本人の番号（ctx.memberId）で必ず絞る。Naoki のデータを触る道具は入れない |

## 作り

- 別の Worker・別の札の置き場（OAUTH_KV）。ここの札は shia2n-mcp には通らない
- 人と権利は shia2n-mcp の `OfficialGate`（サービスの結び）で読む。この Worker に鍵は置かない
- つなぐ画面は Google ログイン（ポータルと同じ Firebase）。札には member の番号だけを入れる

## 口

- `/mcp` … MCP の本体
- `/authorize` … つなぐ画面

## 置き場の作り方（最初の 1 回）

Cloudflare の Workers Builds で、このリポジトリを `official` を根のフォルダにして取り込む（Build command `npm install`・Deploy command `npx wrangler deploy`）。
札の置き場は最初の deploy で自動で作られる。秘密の値は要らない。
Firebase の承認済みドメインに、この Worker の住所を足す（Google ログインの窓を開くため）。

## 試験

`npm test`

## 履歴

- 0.1.0（2026-11-17 開発部・統括の依頼・Naoki OK 15:25）：新設。名簿の道具は `official__my_rights`（自分の権利と使える道具を見るだけ）の 1 本
