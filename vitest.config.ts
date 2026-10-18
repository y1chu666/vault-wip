import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 只统计与 Obsidian 无关的核心逻辑：界面与插件入口由人工验证与端到端测试覆盖。
      include: ["src/core/**/*.ts"],
      reporter: ["text"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
