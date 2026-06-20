import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node'
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core')
    }
  }
})
