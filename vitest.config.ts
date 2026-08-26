import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'packages/gateway-core/src/**/*.ts',
        'packages/security/src/**/*.ts',
        'packages/quota/src/**/*.ts',
        'packages/skills/src/**/*.ts',
        'packages/reports/src/**/*.ts',
        'packages/usage/src/**/*.ts',
        'packages/http/src/**/*.ts',
        'packages/monitoring/src/**/*.ts'
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 75 }
    }
  }
})
