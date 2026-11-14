import { configDefaults, defineConfig } from 'vitest/config';

// study-lambda/ is a separate package with its own dependencies and test run (see its package.json).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'study-lambda/**'] } });
