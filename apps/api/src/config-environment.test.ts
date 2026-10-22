import { describe, expect, it } from "vitest";
import { environmentForMode } from "./config-environment";

const local = {
  name: "task-api-local",
  databaseName: "task-db",
  databaseId: "00000000-0000-4000-8000-000000000000",
};

describe("Cloudflare environment configuration", () => {
  it.each([undefined, "development", "test"])("uses local D1 for mode %s", (mode) => {
    expect(environmentForMode(mode)).toEqual(local);
  });

  it("selects the staging Worker, domain, and D1", () => {
    expect(environmentForMode("staging")).toEqual({
      name: "task-api-staging",
      domain: "task-staging.isksss.dev",
      databaseName: "task-db-staging",
      databaseId: "68a0f133-e48d-45a5-9edc-5a361a37bb07",
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
    });
    expect(() =>
      environmentForMode("production", { productionD1Id: "production-d1-id" }),
    ).toThrow("TASK_ALLOW_PRODUCTION_DEPLOY=1");
  });

  it("rejects TODO database IDs and unknown modes", () => {
    expect(() => environmentForMode("production", { allowProduction: true })).toThrow(
      "TODO-production-d1-id",
    );
    expect(() => environmentForMode("staging", { stagingD1Id: "TODO-staging-d1-id" })).toThrow(
      "TODO-staging-d1-id",
    );
    expect(() => environmentForMode("preview")).toThrow("Unsupported mode: preview");
  });
});
