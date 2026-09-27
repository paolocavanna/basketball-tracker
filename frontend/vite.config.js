import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// https://vite.dev/config/
// `vite build` stays a pure frontend build: Cloudflare deploys the Functions
// separately, so nothing of the local API belongs in the bundle. Only the dev
// and preview servers mount it, which is where /api/* otherwise 404s.
export default defineConfig(async ({ command }) => {
  const plugins = [vue()];
  if (command === "serve") {
    const { localApi } = await import("./dev/localApi.js");
    plugins.push(localApi());
  }
  return { plugins };
});
