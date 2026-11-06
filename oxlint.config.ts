import { defineConfig } from "oxlint";
import { base, node, ignorePatterns } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  ignorePatterns,
  overrides: [{ files: ["scripts/**", "bin/**", "test/**"], ...node }],
});
