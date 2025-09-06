# LINEグループ幹事アシスタントボット

LINEグループでの面倒な「日程調整」から「お店探し」までを、AIが対話形式でアシストしてくれるボットです。

## 主な機能

- **AIによる日程調整**:
  - 「@ボット 来週の土日、または再来週の平日で都合良い日ある？」のように、グループでボトにメンションするだけで、AIが候補日を抽出します。
  - 抽出された候補日で、LIFFアプリを使った投票フォームを自動でグループに投稿します。
  - メンバーはLIFF上で「○△×」を選ぶだけで簡単に出欠を回答でき、結果はリアルタイムで集計・共有されます。

- **AIによる飲食店推薦**:
  - 日程が確定すると、ボットが自動で「お店はどうしますか？」と質問します。
  - 「@ボット 渋谷で個室のある居酒屋」のように希望を伝えると、AIが意図を汲み取り、Google Places APIを利用して最適なお店を5店舗提案します。
  - 提案されたお店は、写真、評価、おすすめ理由付きのカード形式（Flex Message）で表示され、すぐにGoogleマップで確認できます。
  - 確定した日程の営業時間を考慮して提案するため、「お店が閉まっていた」という事態を防ぎます。

## 必要なもの

- **Node.js**: v18以上
- **LINE Developersアカウント**:
  - Messaging APIチャネル
  - LINE Loginチャネル（LIFFでユーザー情報を取得するために利用）
- **ngrok**: ローカル環境で開発・テストを行う際に、外部（LINEプラットフォーム）からのWebhookを受け取るために使用します。
- **APIキー**:
  - **Claude APIキー**: 日程調整やお店の希望を解釈するために使用します。(https://console.anthropic.com/)
  - **Gemini APIキー**: Claudeが利用できない際の代替として、またお店の推薦理由を生成するために使用します。(https://aistudio.google.com/app/apikey)
  - **Google Maps APIキー**: 飲食店情報の検索に必要です。以下のAPIを有効にしてください。
    - Places API
    - Geocoding API

## セットアップ

1.  **リポジトリをクローン**
    ```bash
    git clone <repository_url>
    cd kansuke
    ```

2.  **依存関係のインストール**
    ```bash
    npm install
    ```

3.  **環境変数の設定**
    `.env.example`ファイルをコピーして`.env`ファイルを作成します。
    ```bash
    cp .env.example .env
    ```
    作成した`.env`ファイルに、以下の各値を設定してください。

    - `LINE_CHANNEL_ACCESS_TOKEN`: Messaging APIのチャネルアクセストークン。
    - `LINE_CHANNEL_SECRET`: Messaging APIのチャネルシークレット。
    - `ANTHROPIC_API_KEY`: ClaudeのAPIキー。
    - `GEMINI_API_KEY`: GeminiのAPIキー。
    - `GOOGLE_MAPS_API_KEY`: Google Maps PlatformのAPIキー。
    - `LIFF_ID`: 作成したLIFFアプリのID。
    - `LINE_LOGIN_CHANNEL_ID`: LIFFアプリで利用するLINE LoginチャネルのチャネルID。
    - `BOT_USER_ID` (任意): ボット自身のユーザーID。設定すると、メンションされた場合のみ反応するようになり、より厳密な制御が可能です。
    - `ADMIN_SECRET` (任意): 管理者用APIを保護するためのシークレットキー。

## 実行方法

1.  **ローカルサーバーの起動**
    ```bash
    npm run dev
    ```
    サーバーが `http://localhost:3000` で起動します。

2.  **ngrokでWebhookを公開**
    別のターミナルを開き、以下のコマンドでローカルサーバーを外部に公開します。
    ```bash
    ngrok http 3000
    ```
    表示された`Forwarding`のURL（`https://xxxx-xxxx.ngrok-free.app`のような形式）をコピーします。

3.  **LINE Developersコンソールの設定**
    - Messaging APIチャネルの「Webhook設定」で、Webhook URLに `(コピーしたngrokのURL)/webhook` を設定します。
    - LIFFアプリのエンドポイントURLに、`(コピーしたngrokのURL)/liff/index.html` を設定します。

## 使い方

1.  作成したボットをLINEグループに招待します。
2.  **日程調整**: `@ボット 来週の土日で` のように、ボットにメンションして日程の希望を伝えます。
3.  ボットが候補日を記載した投票フォームを投稿します。
4.  「フォームで回答」ボタンからLIFFアプリを開き、各候補日に○△×で回答します。
5.  全員が回答すると、ボットが締め切りを促します。「はい」を選ぶと、最も票が多かった日を確定できます。
6.  **飲食店検索**: 日程が確定すると、ボットが「次に、お店の希望（エリアや料理ジャンルなど）を教えてください！」と尋ねます。
7.  `@ボット 渋谷で焼肉` のように希望を伝えると、おすすめのお店の情報がカード形式で投稿されます。

## プロジェクト構成

- `src/index.js`: Expressサーバーのメインファイル。WebhookやAPIエンドポイントの定義。
- `src/lib/line.js`: LINEイベント（メッセージ、ポストバック）のメインハンドラ。
- `src/lib/claude.js`: LLM (Claude/Gemini) と連携し、自然言語から日程候補を抽出するロジック。
- `src/lib/shop_suggester.js`: 自然言語から飲食店の検索条件を抽出し、Google Places APIで検索して候補を返すロジック。
- `src/lib/db.js`: データベース (SQLite) のスキーマ定義と操作ロジック。
- `src/lib/flex.js`: 日程調整や飲食店推薦で使うFlex Messageを生成する。
- `src/lib/auth.js`: LIFFのIDトークンを検証する認証ロジック。
- `public/liff/index.html`: 日程調整の投票を行うLIFFアプリのフロントエンド。
- `.env.example`: 環境変数のテンプレートファイル。
- `README.md`: このファイル。