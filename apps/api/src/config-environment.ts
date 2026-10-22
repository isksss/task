const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";
const STAGING_D1_ID = "68a0f133-e48d-45a5-9edc-5a361a37bb07";
const PRODUCTION_D1_ID = "TODO-production-d1-id";

export interface Environment {
  name: string;
  domain?: string;
  databaseName: string;
  databaseId: string;
}

export interface EnvironmentOptions {
  stagingD1Id?: string;
  productionD1Id?: string;
  allowProduction?: boolean;
}

export function environmentForMode(
  mode: string | undefined,
  options: EnvironmentOptions = {},
): Environment {
  switch (mode) {
    case undefined:
    case "development":
    case "test":
      return { name: "task-api-local", databaseName: "task-db", databaseId: LOCAL_D1_ID };
    case "staging": {
      const databaseId = options.stagingD1Id ?? STAGING_D1_ID;
      if (databaseId.startsWith("TODO-")) {
        throw new Error(
          `Staging D1 ID is still a TODO placeholder (${databaseId}) in apps/api/cloudflare.config.ts. Set a real ID before building or deploying with --mode staging.`,
        );
      }
      return {
        name: "task-api-staging",
        domain: "task-staging.isksss.dev",
        databaseName: "task-db-staging",
        databaseId,
      };
    }
    case "production": {
      if (!options.allowProduction) {
        throw new Error(
          "Production mode is disabled unless TASK_ALLOW_PRODUCTION_DEPLOY=1 is set by the deploy:production script.",
        );
      }
      const databaseId = options.productionD1Id ?? PRODUCTION_D1_ID;
      if (databaseId.startsWith("TODO-")) {
        throw new Error(
          `Production D1 ID is still a TODO placeholder (${databaseId}) in apps/api/cloudflare.config.ts. Set a real ID before building or deploying with --mode production.`,
        );
      }
      return {
        name: "task-api",
        domain: "task.isksss.dev",
        databaseName: "task-db",
        databaseId,
      };
    }
    default:
      throw new Error(`Unsupported mode: ${mode}`);
  }
}
