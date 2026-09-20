import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/worker/setup.ts"],
        },
        plugins: [
          cloudflareTest(async () => {
            const TEST_MIGRATIONS = await readD1Migrations("migrations");
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  SESSION_SECRET: "test-secret-0123456789",
                  LINE_CHANNEL_ID: "test-channel",
                  APP_URL_BASE: "https://example.test/app",
                  TEST_MIGRATIONS,
                },
              },
            };
          }),
        ],
      },
      {
        test: {
          name: "web",
          environment: "node",
          include: ["test/web/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
  },
});
