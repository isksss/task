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

`pnpm smoke` は web をビルドし、ローカル D1 migration を適用してから `cf dev` の HTTP 動作を確認します。Cloudflare へのログインは不要です。

API のテストは `@cloudflare/vitest-plugin`（`1.4.6`）を使い、`cloudflare.config.ts` の設定を読み込んで Miniflare 上のローカル D1 で動きます。テストでは `remoteBindings: false` とし、Cloudflare ログインを必要としません。

## デプロイ

staging は `pnpm --filter @task/api deploy:staging`、production は `pnpm --filter @task/api deploy:production` を必ず経由してください。素の `cf deploy` は使わないでください。`cf deploy --help` では `--mode` の既定値は表示されていません。

## D1

バインディング名は `DB`、migration は `apps/api/migrations/` に置きます。ローカルへの適用:

```sh
pnpm --filter @task/api exec cf d1 migrations apply 00000000-0000-4000-8000-000000000000 --local
```

`apps/api/cloudflare.config.ts` のローカル D1 ID はローカル確認用プレースホルダで、staging / production の D1 ID も要設定です。今回は空の初期 migration のみです。Cloudflare へのログイン、リモート D1 作成・変更、デプロイは行いません。
