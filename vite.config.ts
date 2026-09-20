import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  root: "src/web",
  // .env.production（VITE_LIFF_ID）はリポジトリ直下に置く
  envDir: "../..",
  build: { outDir: "../../dist/client", emptyOutDir: true },
  plugins: [
    react(),
    cloudflare({
      configPath: "../../wrangler.jsonc",
      persistState: { path: "../../.wrangler/state" },
    }),
  ],
});
