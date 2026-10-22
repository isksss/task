import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // shortcut: limited by experimental.newConfig and may break on cf/vitest-plugin updates; replace when a stable API is available.
      remoteBindings: false,
      experimental: { newConfig: { configPath: "./cloudflare.config.ts" } },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
