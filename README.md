# shia2n-mcp

shia2n エコシステム統合 MCP ゲートウェイ。Claude（Anthropic）から自然言語で High-Shinくんを操作するための窓口です。

## このアプリは何をするか

```
Naoki（Claude.ai または Anthropic API）
  ↓ 自然言語
Claude
  ↓ MCPプロトコル（Bearer認証）
shia2n-mcp（このアプリ・Cloudflare Workers）
  ↓ 内部API呼び出し（Bearer認証）
High-Shinくん本体（/api/internal/*）
  ↓ Supabase
配信処理
```

**重要な原則:**
- このMCPは**薄いラッパー**。ビジネスロジックは High-Shinくん本体に委譲する。
- Supabase には直接アクセスしない。必ず High-Shinくんの内部API経由。
- AI単独で本番配信は実行しない。`request_approval` で承認URLを発行し、Naokiが承認してから送信。

## 提供するツール（6本）

| ツール名 | 副作用 | 呼ぶ内部API |
|---|---|---|
| `high_shin__search_contacts` | なし | `/api/internal/search-contacts` |
| `high_shin__search_campaigns` | なし | `/api/internal/search-campaigns` |
| `high_shin__get_stats` | なし | `/api/internal/get-stats` |
| `high_shin__create_campaign_draft` | `hs_campaigns` に status=draft で INSERT | `/api/internal/create-draft` |
| `high_shin__edit_campaign_draft` | `hs_campaigns` UPDATE（draftのみ） | `/api/internal/edit-draft` |
| `high_shin__request_approval` | `hs_approval_requests` に INSERT、承認URL返却 | `/api/internal/request-approval` |

## セットアップ手順

### 1. GitHub リポジトリ作成

1. GitHub で `shia2n-mcp` という名前の Public リポジトリを新規作成（README/.gitignore なしの空リポ推奨）
2. このプロジェクトのファイル一式を GitHub Web UI で Upload files
3. ルート直下に `package.json`, `wrangler.jsonc`, `tsconfig.json`, `src/` フォルダなどが配置されていることを確認

### 2. Cloudflare Workers プロジェクト作成（GitHub連携）

1. Cloudflare Dashboard → [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. **Create** → **Workers** → **Import a repository**
3. GitHub アカウントを連携し、`shia2n-mcp` リポを選択
4. Build configuration:
   - **Build command**: `npm install`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: （空欄のまま）
5. **Save and Deploy**

初回ビルドには 2〜3 分かかる。完了すると `https://shia2n-mcp.<あなたのアカウント名>.workers.dev` でアクセス可能になる。

### 3. 環境変数（Secrets）の設定

Cloudflare Dashboard → Workers & Pages → `shia2n-mcp` → **Settings** → **Variables and Secrets**

以下の4つを **Secret**（Type: Secret）として追加：

| 名前 | 値 | 備考 |
|---|---|---|
| `MCP_SERVER_SECRET` | 新規ランダム文字列（64文字以上推奨） | ClaudeがこのMCPに接続するときのBearer token |
| `MCP_DEFAULT_USER_ID` | NaokiのFirebase UID | Firebase Console → Authentication → Users で確認 |
| `HIGH_SHIN_API_BASE` | `https://high-shin.pages.dev` | 末尾スラッシュなし |
| `HIGH_SHIN_INTERNAL_SECRET` | Phase A で High-Shin 側に設定した `MCP_INTERNAL_SECRET` と**同じ値** | 両方が一致しないと認証失敗 |

追加後、再デプロイは不要（Secretsは自動反映）。

### 4. 動作確認

#### (a) ヘルスチェック（ブラウザでOK）

```
https://shia2n-mcp.<あなたのアカウント名>.workers.dev/
```

以下のような JSON が返れば OK：

```json
{ "name": "shia2n-mcp", "version": "0.1.0", "status": "ok", "mcp_endpoint": "/mcp" }
```

#### (b) Bearer 認証のチェック（curl）

```bash
# 認証なし → 401 が返るはず
curl -X POST https://shia2n-mcp.<account>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 正しい Bearer → ツール一覧が返るはず
curl -X POST https://shia2n-mcp.<account>.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <MCP_SERVER_SECRET>" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

#### (c) MCP Inspector で接続確認

Node.js が入った PC で以下を実行（Naoki の手元で実施する場合のみ。スキップ可）：

```bash
npx @modelcontextprotocol/inspector
```

ブラウザで開いた画面で：
- Transport type: **Streamable HTTP**
- URL: `https://shia2n-mcp.<account>.workers.dev/mcp`
- Authentication → Bearer Token: `<MCP_SERVER_SECRET>`
- **Connect** → **List Tools** で 6 本のツールが表示されれば OK

#### (d) Anthropic Messages API から呼び出し

Anthropic Console の Workbench、または以下の curl で：

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "使えるツールを教えて"}],
    "mcp_servers": [{
      "type": "url",
      "url": "https://shia2n-mcp.<account>.workers.dev/mcp",
      "name": "shia2n-mcp",
      "authorization_token": "<MCP_SERVER_SECRET>"
    }],
    "tools": [{
      "type": "mcp_toolset",
      "mcp_server_name": "shia2n-mcp"
    }]
  }'
```

レスポンスで `high_shin__` で始まる 6 本のツールが列挙されれば Phase B 完了。

## 更新・再デプロイ

このリポジトリに push すれば、Cloudflare Workers Builds が自動ビルド＆デプロイする。

- 設定変更のみ（環境変数）: 再デプロイ不要
- コード変更: GitHub Web UI で編集 → Commit → 自動デプロイ（2〜3分）

## 将来の拡張

### フェーズ2.5: Claude.ai Custom Connector 対応（OAuth 2.1）

現在の Bearer 認証では、Claude.ai の Custom Connector UI から接続できない（OAuth 必須）。
追加する場合は `workers-oauth-provider` を組み込み、Firebase Auth とブリッジする。
ツール定義（`src/tools.ts`）は無修正で流用可能。

### フェーズ3: 他アプリ追加

`src/tools/` ディレクトリを作り、アプリごとにファイルを分けて登録する：

```
src/
├── index.ts
├── app-client.ts
└── tools/
    ├── high-shin.ts    ← 現在の tools.ts の内容
    ├── client-os.ts    ← 将来追加
    └── x-pdca.ts       ← 将来追加
```

対応する環境変数（`CLIENT_OS_API_BASE` など）も追加。

## 参照ドキュメント

- [shia2n-mcp-design.md](../shia2n-mcp-design.md)（設計書）
- [shia2n-ecosystem-map.md](../shia2n-ecosystem-map.md)（エコシステム全体像）
- [Cloudflare Agents SDK - createMcpHandler](https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/)
- [Anthropic MCP Connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)
