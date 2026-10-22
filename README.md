# task

## 開発

Node.js 24 と pnpm 12 を使用します。

```sh
pnpm install
pnpm dev
```

`pnpm dev` は web をビルドしてから `apps/api` の Worker を `cf dev` で起動します。`cf` CLI はルートの `devDependency`（`0.15.0`）で固定し、プロジェクト内の scripts から実行します。

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
```

`pnpm smoke` は web をビルドし、development mode でローカル D1 migration を適用してから `cf dev` の HTTP 動作を確認します。Cloudflare へのログインは不要です。

API のテストは `@cloudflare/vitest-plugin`（`1.4.6`）を使い、`cloudflare.config.ts` の設定を読み込んで Miniflare 上のローカル D1 で動きます。テストでは `remoteBindings: false` とし、Cloudflare ログインを必要としません。

## デプロイ

staging は `pnpm --filter @task/api deploy:staging`、production は `pnpm --filter @task/api deploy:production` を経由してください。`TASK_ALLOW_PRODUCTION_DEPLOY=1` は誤操作防止のための意図的な許可フラグであり、強制的なアクセス制御ではありません。環境変数を設定できる利用者は他のコマンドからも production を実行できるため、権限管理は Cloudflare 側で行ってください。`cf deploy --help` では `--mode` の既定値は表示されていません。

## D1

バインディング名は `DB`、migration は `apps/api/migrations/` に置きます。ローカルへの適用:

```sh
pnpm --filter @task/api exec cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local --mode development
```

`apps/api/src/config-environment.ts` のローカル D1 ID はローカル確認用プレースホルダです。staging / production の D1 ID は設定済みです。v1 schema は `0002_v1.sql` にあります。Cloudflare へのログイン、リモート D1 作成・変更、デプロイは行いません。

## Web Push

開発・テストではローカル専用の固定鍵を使います。staging / production で通知を使う場合は、秘密鍵を生成して Worker secret `VAPID_PRIVATE_KEY` に設定してください。公開鍵は `GET /api/push/vapid-public-key` から取得されます。秘密鍵は JSON JWK 形式です。

```sh
umask 077
node scripts/generate-vapid-key.mjs > .vapid-secrets.json
```

この `cf` CLI には secret の個別登録コマンドがなく、`cf deploy --help` によると `--secrets-file` でデプロイ時に設定できます。次のコマンドは Worker をデプロイするため、対象環境と変更内容を確認してから実行してください（このリポジトリの実装・検証作業では実行しません）。

```sh
pnpm --filter @task/api exec cf deploy --mode staging --secrets-file ../../.vapid-secrets.json
# production の場合は --mode production を指定
```

`.vapid-secrets.json` は Git 管理対象外です。鍵の再生成・変更時は既存の Push 購読との互換性を保つため、鍵を失効させる影響を確認してください。staging / production で secret が未設定または不正な場合、Push 送信はスキップしてログに記録されます。
