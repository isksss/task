import { describe, expect, it } from "vitest";
import { environmentForMode } from "./config-environment";

const local = {
  name: "task-api-local",
  databaseName: "task-db",
  databaseId: "00000000-0000-4000-8000-000000000000",
};

describe("Cloudflare environment configuration", () => {
  it.each([undefined, "development", "test"])("uses local D1 for mode %s", (mode) => {
    const environment = environmentForMode(mode);
    expect(environment).toMatchObject(local);
    expect(environment.vars).toMatchObject({
      DEPLOYMENT_ENV: mode === "test" ? "test" : "development",
      AUTH_MODE: mode === "test" ? "test" : "development",
    });
  });

  it("selects the staging Worker, domain, and D1", () => {
    expect(environmentForMode("staging")).toEqual({
      name: "task-api-staging",
      domain: "task-staging.isksss.dev",
      databaseName: "task-db-staging",
      databaseId: "68a0f133-e48d-45a5-9edc-5a361a37bb07",
      vars: {
        DEPLOYMENT_ENV: "staging",
        AUTH_MODE: "access",
        ACCESS_TEAM: "isksss.cloudflareaccess.com",
        ACCESS_AUD: "d3d8d450e0d9d655e51c39abffca0080193e575f05a8398483352b1375c0a4a4",
        ALLOWED_EMAILS: "isksss.prp@gmail.com",
      },
    });
  });

  it("selects production only when explicitly allowed", () => {
    expect(
      environmentForMode("production", {
        allowProduction: true,
        productionD1Id: "production-d1-id",
      }),
    ).toEqual({
      name: "task-api",
      domain: "task.isksss.dev",
      databaseName: "task-db",
      databaseId: "production-d1-id",
      vars: {
        DEPLOYMENT_ENV: "production",
        AUTH_MODE: "access",
        ACCESS_TEAM: "isksss.cloudflareaccess.com",
        ACCESS_AUD: "2dbdca286bd34df54481d3ce4737e5ddf00c7da9d5c34c6b65b6ea7075e3d3cb",
        ALLOWED_EMAILS: "isksss.prp@gmail.com",
      },
    });
    expect(() => environmentForMode("production", { productionD1Id: "production-d1-id" })).toThrow(
      "TASK_ALLOW_PRODUCTION_DEPLOY=1",
    );
  });

  it("rejects TODO database IDs and unknown modes", () => {
    expect(() =>
      environmentForMode("production", {
        allowProduction: true,
        productionD1Id: "TODO-production-d1-id",
      }),
    ).toThrow("TODO-production-d1-id");
    expect(() => environmentForMode("staging", { stagingD1Id: "TODO-staging-d1-id" })).toThrow(
      "TODO-staging-d1-id",
    );
    expect(() => environmentForMode("preview")).toThrow("Unsupported mode: preview");
  });
});
