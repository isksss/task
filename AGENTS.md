# task — コーディングエージェント向け

## プロジェクト

個人用タスク管理 PWA。React / TypeScript の Web アプリを Cloudflare Worker が配信し、API と D1 を使って端末間同期・Web Push を提供します。Worker は Cron による通知送信と期限切れデータの削除も行います。

- `apps/web/src/App.tsx`: 画面・操作の中心となる React コンポーネント
- `apps/web/src/db.ts`: Dexie / IndexedDB、ローカル更新と outbox
- `apps/web/src/sync.ts`: API 同期、ページ取得、再試行
- `apps/web/src/i18n.ts`: 日本語・英語の文言辞書
- `apps/web/src/style.css`, `App.module.css`: 共通テーマ変数と画面スタイル
- `apps/web/src/sw.ts`: オフライン対応と Push 通知の service worker
- `apps/web/src/export.ts`, `calendar.ts`, `push.ts`: エクスポート、カレンダー、Push
- `apps/web/src/task-creation.ts`, `recurrence-form.ts`: タスク作成時の既定値、繰り返し入力
- `apps/web/src/*.{test.ts,tsx}`: Web の単体テスト
- `apps/api/src/auth.ts`: Cloudflare Access 認証とユーザー
- `apps/api/src/sync.ts`: API 側の同期・入力検証
- `apps/api/src/push.ts`: Web Push
- `apps/api/src/schema.ts`: ローカル / テスト用 D1 schema 適用
- `apps/api/migrations/`: Cloudflare D1 migrations
- `apps/api/src/index.ts`: API ルートと Cron handler
- `apps/api/cloudflare.config.ts`, `src/config-environment.ts`: Worker / 環境設定
- `apps/api/src/*.{test.ts,tsx}`: API と設定の単体テスト
- `packages/shared/src/index.ts`: 共有型、HLC、LWW、同期ドメインロジック
- `scripts/`: SQL 整形、smoke、production guard、VAPID 鍵生成
- `playwright.config.ts`, `e2e/task.spec.ts`: Playwright 設定と E2E
- `.github/workflows/ci.yml`: `verify` と staging / production デプロイ

## 開発と検証

- Node.js 24、pnpm 12 を使います。依存関係は `pnpm install` で導入します。
- `pnpm dev`: Web をビルドし、`cf dev` でローカル Worker を起動します。
- `pnpm test`: API と Web の Vitest を実行します。`pnpm check:prod-guard` は guard が有効なことを検証します。
- `pnpm smoke` / `pnpm e2e`: 一時ローカル D1 で Worker を確認します。E2E 初回は `pnpm exec playwright install chromium` が必要です。
- smoke / E2E は Cloudflare にログインせず実行できます。
- 整形は `pnpm fmt`（oxfmt と `scripts/format-sql.mjs`）。確認は `pnpm fmt:check`。
- コード変更後は次を通します。

```sh
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm smoke && pnpm check:prod-guard && pnpm e2e
```

## ブランチとデプロイ

- `develop` から `feature/*` / `fix/*` を作成し、develop 向け PR を出します。staging で確認後、develop から main への PR で本番へ反映します。
- `main` / `develop` は保護ブランチです。直接 push せず、PR と必須 `verify` を通します。
- デプロイは GitHub Actions のみ。手動 `cf deploy` は非常用で、必ず `--secrets-file ../../.vapid-secrets.json` を指定してください。指定しないと Worker secret が消えます。
- production の `cf build` / `cf deploy` には `TASK_ALLOW_PRODUCTION_DEPLOY=1` が必要です。これは誤操作防止用であり、権限管理の代替ではありません。
- `workers_dev: false` と `previewUrls: false` を維持してください（Cloudflare Access の迂回防止）。

## 実装ルール

### 秘密情報

- `.vapid-secrets.json` は VAPID 秘密鍵です。**読まない・表示しない・コミットしない**でください。
- VAPID 鍵を変更すると既存の Push 購読が使えなくなります。鍵の生成・変更を行う場合は影響を確認してください。

### D1 と schema

- D1 schema の変更は `apps/api/migrations/NNNN_*.sql` を追加します。適用済み migration は書き換えません。Cloudflare は migration 名で適用済みかを管理します。
- `apps/api/src/schema.ts` とローカル / テスト用 schema も migration と揃えてください。
- `scripts/format-sql.mjs` と `schema.ts` の分割処理は trigger の単独行 `END;` と、単一行の `ALTER TABLE ... ADD COLUMN ...;` を前提にしています。SQL を変更するときはこの形を保ち、`pnpm fmt:check` を確認してください。

### 同期と設定

- production / staging のユーザー識別は検証済み Cloudflare Access JWT から行います。クライアント入力の `user_id` は信頼しません（development / test はローカル認証モードを使います）。
- 入力検証はサーバー側でも必須です。クライアント側の検証だけに依存しないでください。
- 同期の不変条件: フィールド単位 LWW を HLC で順序付ける、各変更を `change_id` で冪等に適用する、`seq` はユーザー単位で単調増加させる。
- 設定項目を増やすときは users 列 / `SETTINGS_KEYS` / Dexie / export / i18n / UI を揃えます。既定の優先度・プロジェクトの実装を参照してください。

### UI

- 表示文言は `apps/web/src/i18n.ts` に追加し、ja / en の両方を揃えます。
- アクセシブルな `role` / label を保ってください。E2E はアクセシビリティ属性を使って UI を操作します。
- 色は `style.css` の CSS 変数を使い、ライト・ダーク両方で確認します。通常テキストのコントラスト比は 4.5:1 以上を保ってください。

### 変更の進め方

- 既知の制限を残す場合は、理由と見直し条件を `shortcut: <the limit>, <when to upgrade>` 形式のコメントで記録します。
- コミットは小さく保ちます。整形だけの変更は別コミットにし、`.git-blame-ignore-revs` に登録してください。
