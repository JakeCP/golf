import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Playwright fixture tests under tests/playwright run via `npm run test:playwright`.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/playwright/**'],
  },
})