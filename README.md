# task

## 開発

Node.js 24 と pnpm 12 を使用します。

```sh
pnpm install
pnpm dev
```

`pnpm dev` は web をビルドしてから `apps/api` の Worker を `cf dev` で起動します。`cf` CLI はルートの `devDependency`（`0.15.0`）で固定し、プロジェクト内の scripts から実行します。

```sh
pnpm fmt          # format files
pnpm fmt:check    # check formatting
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm e2e
```

`pnpm fmt` は `**/*.sql` も SQLite 方言で整形します（設定: `.sql-formatter.json`）。

`pnpm smoke` は web をビルドし、development mode でローカル D1 migration を適用してから `cf dev` の HTTP 動作を確認します。`pnpm e2e` は同じ一時 D1 環境に Chromium で接続し、ブラウザー操作と同期を検証します。初回は `pnpm exec playwright install chromium` でブラウザーを導入してください。どちらも Cloudflare へのログインは不要です。

Vitest では API・共有ロジック・ローカル DB に加え、同期のページ分割／バッチ送信の途中失敗、再試行、同期中の追加編集（タスク・プロジェクト・タグ・タグ紐付け・設定）、認証／応答異常、全件再同期と削除競合を検証します。E2E ではタスクの作成・完了・復元、オフライン／同時編集、既定値、認証切れからの復旧、完全削除のキャンセルと確定、編集キャンセル、うるう日をまたぐ繰り返しタスク、JSON エクスポートを検証します。

E2E の HTML レポートは `playwright-report/` に出力されます。失敗時はスクリーンショットとトレースを `test-results/` に保存し、CI では両方を `playwright-report` artifact として 7 日間保持します。ローカルのレポートは `pnpm exec playwright show-report` で開けます。

API のテストは `@cloudflare/vitest-plugin`（`1.4.6`）を使い、`cloudflare.config.ts` の設定を読み込んで Miniflare 上のローカル D1 で動きます。テストでは `remoteBindings: false` とし、Cloudflare ログインを必要としません。

## デプロイ

Cloudflare にログインした状態で、対象環境の D1 migration を適用してから Worker をデプロイしてください。リモート migration では `--local` を付けません。deploy scripts は毎回 `.vapid-secrets.json` を `--secrets-file` として渡すため、ファイルを用意してから実行してください（生成方法は「Web Push」を参照）。secret を渡さない `cf deploy` は登録済み Worker secret を削除します。

### staging

```sh
pnpm --filter @task/api exec cf d1 migrations apply 68a0f133-e48d-45a5-9edc-5a361a37bb07 --dir migrations --mode staging
pnpm --filter @task/api deploy:staging
pnpm --filter @task/api exec cf workers secrets list --worker task-api-staging
```

### production

```sh
pnpm --filter @task/api exec cf d1 migrations apply de04dcfd-4fb3-441c-89c0-868f5a47730c --dir migrations --mode production
pnpm --filter @task/api deploy:production
pnpm --filter @task/api exec cf workers secrets list --worker task-api
```

デプロイ後、`cf workers secrets list --worker <name>` で `VAPID_PRIVATE_KEY` が残っていることを確認してください。`deploy:production` は誤操作防止のため `TASK_ALLOW_PRODUCTION_DEPLOY=1` を設定します。このフラグは強制的なアクセス制御ではありません。環境変数を設定できる利用者は他のコマンドからも production を実行できるため、権限管理は Cloudflare 側で行ってください。

## D1

バインディング名は `DB`、migration は `apps/api/migrations/` に置きます。ローカルへの適用:

```sh
pnpm --filter @task/api exec cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local --mode development
```

ローカル D1 ID はローカル確認用プレースホルダです。staging / production の D1 ID は `apps/api/src/config-environment.ts` に設定されています。v1 schema は `0002_v1.sql` にあります。リモート操作では Cloudflare ログインが必要です。

## Web Push

開発・テストではローカル専用の固定鍵を使います。staging / production で通知を使う場合、VAPID 秘密鍵（JSON JWK 形式）を Worker secret `VAPID_PRIVATE_KEY` として登録します。公開鍵は `GET /api/push/vapid-public-key` から取得されます。deploy scripts は毎回 `.vapid-secrets.json` を `--secrets-file` として渡すので、ファイルが無い場合は次の手順で生成してください。

```sh
umask 077
node scripts/generate-vapid-key.mjs > .vapid-secrets.json
```

`.vapid-secrets.json` は Git 管理対象外です。deploy 後は「デプロイ」に記載した `cf workers secrets list --worker <name>` で `VAPID_PRIVATE_KEY` を確認してください。鍵の再生成・変更時は既存の Push 購読との互換性を保つため、鍵を失効させる影響を確認してください。staging / production で secret が未設定または不正な場合、Push 送信はスキップしてログに記録されます。
