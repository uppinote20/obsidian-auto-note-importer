import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/main.ts', 'src/ui/**']
    }
  },
  resolve: {
    alias: {
      obsidian: './tests/__mocks__/obsidian.mock.ts'
    }
  }
});
