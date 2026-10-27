import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 통합 테스트는 실제 PostgreSQL 하나를 공유하므로 파일 단위 병렬 실행을 끕니다.
    fileParallelism: false,
    // 공개 사례를 여러 건 만드는 통합 테스트는 로컬 Docker PostgreSQL에서 5초(기본값)를 넘길 수 있습니다.
    testTimeout: 60_000,
  },
})
