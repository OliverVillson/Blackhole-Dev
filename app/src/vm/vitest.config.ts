// Runs this module's tests on their own (CI workflow vm.yml): `npx vitest run --config src/vm/vitest.config.ts` from app/.
export default { esbuild: { jsx: "automatic" }, test: { include: ["src/vm/**/*.test.{ts,tsx}"] } };
