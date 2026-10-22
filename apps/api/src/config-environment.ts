const LOCAL_D1_ID = "00000000-0000-4000-8000-000000000000";
const STAGING_D1_ID = "68a0f133-e48d-45a5-9edc-5a361a37bb07";
const PRODUCTION_D1_ID = "de04dcfd-4fb3-441c-89c0-868f5a47730c";

export interface Environment {
  name: string;
  domain?: string;
  databaseName: string;
  databaseId: string;
  vars: {
    DEPLOYMENT_ENV: string;
    AUTH_MODE: string;
    ACCESS_TEAM: string;
    ACCESS_AUD: string;
    ALLOWED_EMAILS: string;
  };
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
      return {
        name: "task-api-local",
        databaseName: "task-db",
        databaseId: LOCAL_D1_ID,
        vars: {
          DEPLOYMENT_ENV: mode === "test" ? "test" : "development",
          AUTH_MODE: mode === "test" ? "test" : "development",
          ACCESS_TEAM: "isksss.cloudflareaccess.com",
          ACCESS_AUD: "local-only",
          ALLOWED_EMAILS: "isksss.prp@gmail.com",
        },
      };
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
        vars: {
          DEPLOYMENT_ENV: "staging",
          AUTH_MODE: "access",
          ACCESS_TEAM: "isksss.cloudflareaccess.com",
          ACCESS_AUD: "d3d8d450e0d9d655e51c39abffca0080193e575f05a8398483352b1375c0a4a4",
          ALLOWED_EMAILS: "isksss.prp@gmail.com",
        },
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
        vars: {
          DEPLOYMENT_ENV: "production",
          AUTH_MODE: "access",
          ACCESS_TEAM: "isksss.cloudflareaccess.com",
          ACCESS_AUD: "2dbdca286bd34df54481d3ce4737e5ddf00c7da9d5c34c6b65b6ea7075e3d3cb",
          ALLOWED_EMAILS: "isksss.prp@gmail.com",
        },
      };
    }
    default:
      throw new Error(`Unsupported mode: ${mode}`);
  }
}
