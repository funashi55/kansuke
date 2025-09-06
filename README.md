# LINE 日程調整デモ (Claude + SQLite + ngrok)

自由形式のコメント (例: 「8月の土日」) を LINE グループで Bot にメンションすると、Claude が会話文を作成しつつ、Function Calling で候補日が確定したタイミングで状態を更新→アンケートを自動作成します。投票はポストバックで受け取り、SQLite に保存・集計します。

注: LINE のネイティブ「投票」機能は Messaging API から直接は作成できないため、このリポジトリでは Flex メッセージ + Postback で擬似アンケートを実装しています。

## 必要なもの (あなたがやること)

- LINE Developers で Messaging API チャネルを作成
  - チャネルアクセストークン (長期) と チャネルシークレット を取得
  - 「グループへの参加を許可」をオン
  - Webhook を「利用する」に設定 (URL は後で ngrok URL を設定)
- Bot を対象のグループに招待
- Claude API キー (Anthropic) を取得 https://console.anthropic.com/
- ngrok のインストール https://ngrok.com/
- Node.js 18+ (推奨) の用意

## セットアップ

1) 依存関係のインストール

```
npm i
```

2) 環境変数ファイルの作成

`.env.example` を `.env` にコピーし、各値を設定します。

```
cp .env.example .env
```

必須:
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `ANTHROPIC_API_KEY` (無くても動きますが、候補日抽出は簡易ロジックになります)

任意:
- `BOT_USER_ID` (メンション検出を厳密化。ボットの userId を設定すると、メンション時のみ起動できます)
- `PORT` (デフォルト 3000)
- `DB_PATH` (デフォルト `./data/app.sqlite`)

3) ローカル起動

```
npm run dev
```

4) ngrok で公開 (別ターミナル)

```
ngrok http 3000
```

表示された https の Forwarding URL を LINE の Webhook URL に設定します。例: `https://xxxx-xx-xx-xx.ngrok-free.app/webhook`

5) 動作確認

- Bot をグループに追加
- グループで Bot をメンションし、自由形式で送信:
  - 例: `@ボット 8月の土日`
- Bot が候補日を解析し、投票用 Flex メッセージを投稿
- いずれかの候補「投票」ボタンを押すと、投票が記録され、直後に集計が返信されます
  （集計はLIFF内で確認できます。Flexにはデフォルトで「フォームで回答」のみ表示します）

## 仕組み概要

- `src/index.js`: Express + LINE webhook 受け口
- `src/lib/line.js`: イベントハンドラ (メッセージ/ポストバック)
- `src/lib/claude.js`: Claude とのやり取り（通常抽出＋Function Calling）。API キーが無い場合は週末候補の簡易生成。
- `src/lib/db.js`: SQLite スキーマと投票ロジック
- `src/lib/flex.js`: 投票用 Flex メッセージ生成
  - セッション状態: `sessions`, `session_candidates`（メンションで開始→Claude のツール呼び出しで候補を保存→投票作成）
- `src/lib/auth.js`: LIFF IDトークン検証（LINE Loginのverifyエンドポイント）
- `src/lib/sse.js`: リアルタイム更新用のシンプルなSSEチャンネル
- `public/liff/index.html`: 参加者用のLIFFフォーム（○/△/× 投票 + リアルタイム集計）

DB スキーマ:
- polls(id, group_id, title, created_at, status)
- options(id, poll_id, label, date)
- votes(poll_id, option_id, user_id, user_name, voted_at)

単一選択の投票（ポストバック）に加えて、LIFF フォームでは各候補に対して ○/△/× を独立に投票できます。
LIFF の投票は `votes3` テーブルに保存され、集計は ○/△/× で表示されます。Flex の「投票」ボタンは簡易に「○」として記録されます。

## LIFF での投票（調整さん風のUI）

- LIFF 準備:
  - LINE Developers → LIFF → 新規作成
  - エンドポイントURL: `https://<あなたの公開URL>/liff/index.html`
  - 取得した `LIFF_ID` を `.env` に設定
  - LIFFはLINE Loginチャネルを前提とするため、そのチャネルIDを `.env` の `LINE_LOGIN_CHANNEL_ID` に設定
  - 開発中は `SKIP_OIDC_VERIFY=1` で検証をスキップ可能（本番不可）

- 使い方:
  - Flexメッセージに「フォームで回答」ボタンが表示されます（`LIFF_ID` を設定した場合）
  - 押下すると LIFF 内のフォームが開き、各日付に対して ○/△/× を選んで「保存」
  - 同時に開いている他ユーザーの画面には SSE によるリアルタイム集計が反映されます
  - 締切（deadline）以降はサーバ側で更新を拒否します

- API（フロントエンドから呼ばれます）
  - `GET /api/polls/:pollId`（要 Authorization: Bearer <LIFFのIDトークン>）
  - `POST /api/polls/:pollId/votes3`（choices: [{ optionId, choice(0|1|2) }])
  - `GET /api/polls/:pollId/stream`（SSE）

- 管理（任意）
  - `POST /api/polls/:pollId/deadline` で締切設定（ヘッダ `Authorization: Bearer <ADMIN_SECRET>` 必須）
  - `.env` の `ADMIN_SECRET` を設定

### メンション時の挙動（会話 + Function Calling）
- メンションを含むメッセージはすべて Claude に渡します。
- Claude は自然な返信文を作成し、候補日が確定できる場合のみ `update_event_candidates` ツールを呼び出します。
- ツール入力で受け取った候補日をセッションへ保存し、直ちに投票を作成してグループへ投稿します（返信文 + Flex の2通）。
- ツールが呼ばれなかった場合は、従来の抽出ロジックで候補を推定して投票を作成します。

## 本番運用 (Cloud Run + Cloud SQL)

ローカルは SQLite で十分ですが、本番は Cloud SQL (PostgreSQL か MySQL) を推奨します。移行の考え方:

- このコードでは DB アクセスを `db` オブジェクトのメソッドに集約しています。
- 本番用に Cloud SQL のクライアント (例: `pg` や `mysql2`) を使った `db` 実装を別ファイルで用意し、`initDB()` の差し替えで対応可能です。
- Cloud Run から Cloud SQL へは Cloud SQL Auth Proxy を使うか、サーバレス接続を構成します。

大まかな手順:
1. Cloud SQL インスタンス作成 (PostgreSQL 推奨)。
2. データベース/スキーマ作成 (polls/options/votes を同様に用意)。
3. Cloud Run サービスを作成し、環境変数と接続情報 (インスタンス接続名) を設定。
4. `initDB()` を Postgres 実装に置換 (後で追加実装可能)。
5. https エンドポイントを LINE の Webhook に設定。

セキュリティ:
- アクセストークン/シークレット/API キーは必ず Secret Manager などで管理。
- Cloud Run の最小インスタンス数 0/1、同時実行などは負荷と用途で調整。

## 制限・注意事項

- LINE メッセージは編集できないため、投票結果の確認はLIFF内のリアルタイム集計で行います。
- Claude の応答が JSON 以外を返す場合、フォールバックで週末候補を提示します。
- Flex のボタン数に上限があるため、候補は最大 10 件に制限しています。

## よくあるトラブル

- 署名検証エラーで 401: `LINE_CHANNEL_SECRET` が不一致の可能性。
- Webhook が 200 以外: ngrok 側 URL 誤りやローカル停止。
- メンションで反応しない: ボットの userId 取得に失敗している可能性。起動ログに `[BOOT] Resolved botUserId:` が出ているか確認。環境で取得できない場合は `.env` の `BOT_USER_ID` を設定してください（メンションは「ボット宛て」のみ反応）。
# kansuke
