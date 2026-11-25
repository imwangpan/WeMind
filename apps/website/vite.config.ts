import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    ignorePatterns: ['docs/.vitepress/dist/**', 'docs/.vitepress/cache/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
    semi: false,
    ignorePatterns: [
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
      'docs/**/*.md',
      'docs/public/**',
    ],
  },
  test: {
    include: ['docs/.vitepress/theme/**/*.test.ts'],
  },
})
