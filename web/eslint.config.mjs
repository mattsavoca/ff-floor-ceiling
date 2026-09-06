import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  { rules: { "react-hooks/set-state-in-effect": "off", "react-hooks/incompatible-library": "off" } },
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts", "tsconfig.tsbuildinfo"]),
]);
