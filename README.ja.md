# OpenCode ChatGPT Bridge — 日本語ガイド

[English](README.md) · [Windowsで使う](#windowsでの導入) · [権限とセキュリティ](#権限とセキュリティ)

**ChatGPTから、ローカルで動作しているOpenCode v2の既存セッションをMCP経由で参照・操作するためのBridgeです。** Windowsでの実行、既存OpenCodeサービスの再利用、セッション履歴の取得、メッセージ送信、完了確認、差分レビューに対応しています。

```text
ChatGPT / MCPクライアント
         ↓
HTTPS・OAuth Gateway（必要な場合。別コンポーネント）
         ↓
OpenCode Bridge（127.0.0.1:8787/mcp）
         ↓
OpenCode v2の既存サービス → 既存セッション
```

**注意：**「送信のみ許可」とはMCPで公開する操作を制限する意味です。送信された指示をOpenCodeが実行すると、OpenCode側の権限次第でファイル編集やコマンド実行が行われます。OSやファイルシステムを読み取り専用にする機能ではありません。

## 主な機能

- 既存セッションへのアタッチ。新規セッションを作成する必要はありません。
- 履歴・実行状態の取得、指示送信、完了待機、応答・ファイル差分の確認。
- Windowsの `C:\` ドライブ文字や、`;` 区切りの複数許可パスに対応。
- 既存OpenCode v2サービスを使うモード。制限モードでは勝手にOpenCodeサーバーを起動しません。
- 12ツールの読み取りモード／13ツールの読み取り＋送信モード。
- アクセス可能なプロジェクトディレクトリの制限、Bearer認証、既知の秘密ファイル読み取り拒否。

## 利用モード

| 設定 | 利用できる機能 | ツール数 |
|---|---|---:|
| `READ_ONLY=true`、送信OFF | 読み取り・一覧・アタッチ・レビュー | 12 |
| `READ_ONLY=true`、送信ON | 上記に既存セッションへの指示送信を追加 | **13** |
| `READ_ONLY=false` | セッション作成・中断・権限応答なども可能 | 19 |

正確な変数名は `OPENCODE_BRIDGE_READ_ONLY` と `OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE` です。推奨は**必要な場合にだけ送信をONにする制限モード**。制限モードでは `opencode_start`、`opencode_stop`、`opencode_create_session`、`opencode_abort`、`opencode_respond_permission`、`opencode_capabilities` を公開しません。

## Windowsでの導入

必要なもの：**Node.js 20以降、pnpm 10以降、OpenCode v2**。利用したいモデル・プロバイダはOpenCode本体側で設定してください。

PowerShellから実行します。`C:\Projects\my-repo` は実在する自分のプロジェクトに置き換えてください。

```powershell
git clone https://github.com/blackcomb-labs/opencode-chatgpt-bridge.git
Set-Location .\opencode-chatgpt-bridge
pnpm install
pnpm run build
node .\dist\cli.js init --allowed-roots "C:\Projects\my-repo"
```

`init` が生成する `.env` にはランダムなBridge用Bearerトークンが入ります。**値をGitHubに公開したり、チャットに貼ったりしないでください。** `.env` は `.gitignore` の対象です。

生成された `.env` の設定を次のように調整します。同じ項目が既にあれば、行を追加せず**既存の値を変更**してください。

```dotenv
OPENCODE_BRIDGE_HOST=127.0.0.1
OPENCODE_BRIDGE_PORT=8787
OPENCODE_BRIDGE_AUTO_PORT=false
OPENCODE_BRIDGE_TUNNEL=none
OPENCODE_BRIDGE_USE_SERVICE=true
OPENCODE_BRIDGE_READ_ONLY=true
OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=false
OPENCODE_BRIDGE_ALLOWED_ROOTS=C:\Projects\my-repo
# initで生成されたOPENCODE_BRIDGE_TOKENは変更・削除しない
```

ChatGPTから既存セッションへ送信したい場合だけ、`OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=true` にします。複数のWindowsパスを許可する場合は `C:\Projects\one;D:\Work\two` のように `;` で区切ります（macOS/Linuxは `:`）。ホームディレクトリ全体を許可するのは避けてください。

OpenCodeの既存サービスを起動したうえで、次を実行します。

```powershell
.\scripts\start-windows.example.bat
```

または `pnpm start`。サンプルバッチには個人の絶対パスもトークン値も含めていません。環境変数は `.env` から読み込まれます。

Bridgeの応答確認：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
pnpm run validate
```

`health` の公開応答は最小限です。セッション取得まで確かめるには、認証済みのMCPクライアントから `bridge_health` と `opencode_list_sessions` を呼び出します。

### 既存OpenCodeサービスへの接続

`OPENCODE_BRIDGE_USE_SERVICE=true` は、OpenCodeの既存バックグラウンドサービスの接続情報を利用します。既定の設定ファイルはユーザーディレクトリ内の `.local/state/opencode/service.json`。別の場所なら `OPENCODE_BRIDGE_SERVICE_CONFIG` を設定してください。

読み取り／読み取り＋送信モードでは、サービスが使えないとき**別のサーバーを勝手に立てず失敗**します。

## ChatGPTとの接続（別のOAuth Gatewayを使う場合）

ChatGPTのWebサービスからWindowsのlocalhostへ直接接続することはできません。外部HTTPSと適切な認証を備えたMCP Gatewayなどを**別途**構築する必要があります。今回の開発で使用したOAuth Gatewayのコード・ドメイン・認証情報は**このリポジトリには含まれていません**。

送信モードを使う場合は、Bridge側とGateway側の**両方**の許可が必要です。

```dotenv
# Bridge側（本リポジトリ）
OPENCODE_BRIDGE_READ_ONLY=true
OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=true

# 今回の連携テストで使った別Gatewayの設定例
OPENCODE_MCP_ENABLED=true
OPENCODE_MCP_READ_ONLY=true
OPENCODE_MCP_ALLOW_SEND_MESSAGE=true
```

`OPENCODE_MCP_*` は**Bridge本体の環境変数ではありません**。他のGatewayでも通用する共通規格ではなく、今回の外部Gatewayの実装に固有の設定例です。外部OAuthトークンとBridge内部のBearerトークンは混同せず、Gateway内部で適切に処理する必要があります。

GatewayやBridgeの再起動後、ChatGPT側のツール表示が古い場合はコネクタを再読み込みしてください。

## 既存セッションでの使い方

1. `opencode_list_sessions` で許可ディレクトリ配下のセッションを列挙。
2. `opencode_attach_session` で既存の `opencodeSessionId` をアタッチ。
3. `opencode_get_messages`、`opencode_get_session_status` で内容や進行状態を確認。
4. 送信許可時は、返された **`bridgeSessionId`** を指定して `opencode_send_message`。`wait=true` または別の待機ツールで完了を確認。
5. `opencode_get_diff`、`opencode_vcs_status` で変更点を検証。

セッションの `location.directory` は、後から編集したリポジトリではなく**そのセッションを開始したディレクトリ**の場合があります。許可ルート外のセッションは一覧・アタッチ・送信対象になりません。

### 実際の往復テスト

Windows＋別OAuth Gatewayという構成で、既存のテストセッションに短い指示を送り、`OK` が返信されることを確認済み。`succeeded`、タイムアウトなし、ファイル差分0件でした。これは**今回の実環境での検証結果**であり、すべてのOpenCodeバージョンやChatGPT環境での動作保証ではありません。

## 権限とセキュリティ

- `OPENCODE_BRIDGE_ALLOWED_ROOTS` は必要なディレクトリだけにすること。既存セッションの保存先が変わった場合も再検証されます。
- BridgeのMCP APIにはBearerトークンを設定。インターネットからアクセスできる場合はHTTPSと適切な外部認証が必要です。
- トークンをURLのクエリ・パスへ埋め込まない（既定OFF）。
- `.env`、`service.json`、`opencode.json`、秘密鍵ファイルなど、既知のパスの読み取りを制限。ただし**一般のソースファイル・ログ・差分・セッション履歴に混入した秘密は完全には防げません**。
- `opencode_capabilities` は制限モードでは公開せず、フルアクセスでもプロバイダの生設定を返さない実装です。
- 送信可能なMCPツールが1個でも、OpenCode本体は指示に従ってコード変更・コマンド実行を行い得ます。
- GitHubへの公開前にステージ済み差分とGit履歴を秘密情報スキャン。万一漏出したAPIキーは失効・交換してください。

## テストと既知の制約

```powershell
pnpm run validate
```

2026-10-22時点のWindowsで、TypeScript型チェック・30件の単体テスト・ビルドが成功しています。`pnpm run e2e` は既存コードにありますが、OpenCodeを起動して書き込み動作まで試すため、使い捨ての検証環境でのみ実行してください。既存の `scripts/selftest.mjs` には環境固有パスが残っており、このWindowsの検証対象外です。

macOS向けのシェルスクリプト／デスクトッププラグイン用スクリプトも残されていますが、今回のWindows＋OAuth Gateway構成とは別の導入方法です。

## フォーク元・ライセンス

- [overlordxrz-source/opencode-chatgpt-bridge](https://github.com/overlordxrz-source/opencode-chatgpt-bridge) — OpenCode v2移植版。
- [yuga-hashimoto/opencode-chatgpt-bridge](https://github.com/yuga-hashimoto/opencode-chatgpt-bridge) — オリジナル版。

ライセンスはMIT。元の著作者表示を含む [`LICENSE`](LICENSE) を維持します。

## AIを活用した開発

このフォークの実装・テストには **OpenCode＋DeepSeek**、連携検証やドキュメント整備には **ChatGPT** の支援を利用しています。

Bridge自体は特定のAIモデルに依存せず、OpenCodeで利用可能な好みのモデルやプロバイダーを使用できます。

AI支援による変更についても、通常の開発と同様にテストとセキュリティチェックを実施しています。
