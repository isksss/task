import { bindings, defineConfig, triggers } from "cf/config";
import { COMPATIBILITY_DATE } from "./compatibility-date.ts";
import { environmentForMode } from "./src/config-environment.ts";

export default defineConfig(({ mode }) => {
  const environment = environmentForMode(mode, {
    allowProduction: process.env.TASK_ALLOW_PRODUCTION_DEPLOY === "1",
  });

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
