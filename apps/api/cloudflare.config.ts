import { bindings, defineConfig, triggers } from "cf/config";
import { COMPATIBILITY_DATE } from "./compatibility-date.ts";

const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";
const STAGING_D1_ID = "68a0f133-e48d-45a5-9edc-5a361a37bb07";
const PRODUCTION_D1_ID = "TODO-production-d1-id";
// Vite defaults build mode to production even when cf's --mode is omitted.
const hasExplicitMode = process.argv.some((arg: string) => arg === "--mode" || arg === "-m" || arg.startsWith("--mode=") || arg.startsWith("-m="));

export default defineConfig(({ mode }) => {
  const configMode = !hasExplicitMode && mode === "production" ? undefined : mode;

  if (configMode === "staging" && STAGING_D1_ID.startsWith("TODO-")) {
    throw new Error(
      `Staging D1 ID is still a TODO placeholder (${STAGING_D1_ID}) in apps/api/cloudflare.config.ts. Set a real ID before building or deploying with --mode staging.`,
    );
  }
  if (configMode === "production" && PRODUCTION_D1_ID.startsWith("TODO-")) {
    throw new Error(
      `Production D1 ID is still a TODO placeholder (${PRODUCTION_D1_ID}) in apps/api/cloudflare.config.ts. Set a real ID before building or deploying with --mode production.`,
    );
  }

  let environment;
  switch (configMode) {
    case undefined:
    case "development":
    case "test":
      environment = { name: "task-api-local", databaseName: "task-db", databaseId: LOCAL_D1_ID };
      break;
    case "staging":
      environment = {
        name: "task-api-staging",
        domain: "task-staging.isksss.dev",
        databaseName: "task-db-staging",
        databaseId: STAGING_D1_ID,
      };
      break;
    case "production":
      environment = {
        name: "task-api",
        domain: "task.isksss.dev",
        databaseName: "task-db",
        databaseId: PRODUCTION_D1_ID,
      };
      break;
    default:
      throw new Error(`Unsupported mode: ${mode}`);
  }

  return {
    worker: {
      name: environment.name,
      ...(environment.domain ? { domains: [environment.domain] } : {}),
      compatibilityDate: COMPATIBILITY_DATE,
      entrypoint: "./src/index.ts",
      workersDev: false,
      previewUrls: false,
      triggers: [
        triggers.scheduled({ schedule: "* * * * *" }),
        triggers.scheduled({ schedule: "0 0 * * *" }),
      ],
      env: {
        DB: bindings.d1({ name: environment.databaseName, id: environment.databaseId }),
        ASSETS: bindings.assets(),
      },
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: true,
      },
    },
  };
});
