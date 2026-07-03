import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  // mirror the "@/*" -> project root alias from tsconfig so tests resolve imports
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
