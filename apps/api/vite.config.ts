import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({
      persistState: process.env.TASK_LOCAL_PERSIST_STATE
        ? { path: process.env.TASK_LOCAL_PERSIST_STATE }
        : true,
      experimental: {
        newConfig: { cfBuildOutput: true },
      },
    }),
  ],
});
