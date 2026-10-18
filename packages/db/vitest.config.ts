import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 통합 테스트는 실제 PostgreSQL 하나를 공유하므로 파일 단위 병렬 실행을 끕니다.
    fileParallelism: false,
  },
})
