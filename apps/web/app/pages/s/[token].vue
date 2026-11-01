<script setup lang="ts">
/**
 * 제한 공유 링크 페이지(E-07, DELIVERY_PLAN §4.4, ADR 0051). 학생이 판 하나를 골라 만든 링크를 받은 사람(채용 담당자 등)이 로그인 없이 봅니다.
 * - 공개 조회 API(`/api/v1/public/share/:token`)만 부르고 로그인 상태를 읽지 않는 공개 레이아웃을 씁니다(보는 사람 정보가 HTML·payload에 없음).
 * - 그 판의 포트폴리오 보기(대표 케이스·역량 × 근거·자기 선언 스킬)와 프로필 기본 필드만. 공개 프로필보다 좁습니다: 타임라인·후배 기여·
 *   과제 수행 목록·팔로우·소셜 링크·학교 인증 배지·상대 페르소나 링크가 없습니다. 볼 수 없게 된 케이스는 공개 프로필처럼 안내만.
 * - 늘 `noindex`·`no-store`·`Referrer-Policy: no-referrer`(출처 칩을 눌러도 토큰이 Referer로 새지 않음). OG 설명·제목에 토큰이나 글을 싣지 않습니다.
 * - 철회·만료·새 판으로 바뀜·프로필 숨김은 다음 요청부터 "링크를 열 수 없습니다"(404)이고 어느 경우인지 밝히지 않습니다.
 */
import type { SharedPortfolioDto } from '~~/shared/types/api'

definePageMeta({ layout: 'public' })

const route = useRoute()
const token = computed(() => String(route.params.token))
const { data: shared, error } = await useAsyncData(
  () => `share:${token.value}`,
  () => $fetch<SharedPortfolioDto>(`/api/v1/public/share/${encodeURIComponent(token.value)}`),
)
const status = computed(() => {
  const code = (error.value as { statusCode?: number } | null)?.statusCode
  return code === 503 || code === 429 ? code : 404
})
if (import.meta.server) {
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  useResponseHeader('x-robots-tag').value = 'noindex, nofollow, noarchive'
  const event = useRequestEvent()
  if (event && error.value) setResponseStatus(event, status.value)
}
useHead({
  title: () => (shared.value ? `${shared.value.displayName} 포트폴리오 — Peerchive` : '공유 링크 — Peerchive'),
  meta: [
    { name: 'robots', content: 'noindex, nofollow, noarchive' },
    { name: 'referrer', content: 'no-referrer' },
  ],
})
</script>

<template>
  <div>
    <template v-if="error || !shared">
      <template v-if="status === 503">
        <h1>잠시 공개 페이지를 볼 수 없습니다</h1>
        <p>점검 중입니다. 잠시 뒤 다시 열어 주세요.</p>
      </template>
      <template v-else-if="status === 429">
        <h1>요청이 너무 많습니다</h1>
        <p>잠시 뒤 다시 열어 주세요.</p>
      </template>
      <template v-else>
        <h1>링크를 열 수 없습니다</h1>
        <p>없거나 만료·철회된 공유 링크입니다. 링크를 보낸 사람에게 새 링크를 요청하세요.</p>
      </template>
    </template>
    <article v-else class="profile-page" aria-labelledby="shared-name" data-testid="shared-portfolio">
      <header class="profile-header">
        <p class="small muted">공유받은 포트폴리오 · 판 v{{ shared.edition.version }}</p>
        <h1 id="shared-name">{{ shared.displayName }} <span class="muted">@{{ shared.handle }}</span></h1>
        <p v-if="shared.kind === 'display'" class="small muted">표시명 프로필</p>
        <p v-if="shared.jobTargets.length || shared.gradTerm" class="small">
          <template v-if="shared.jobTargets.length">{{ shared.jobTargets.join(', ') }} 지망</template>
          <template v-if="shared.gradTerm"> · {{ shared.gradTerm }} 졸업(예정)</template>
        </p>
        <p v-if="shared.headline" class="profile-headline">“{{ shared.headline }}”</p>
        <p class="actions small">
          <span v-if="shared.openToWork" class="badge">구직 중</span>
          <span>연락: {{ shared.contactText }}</span>
        </p>
        <p v-if="shared.schoolLabel" class="small muted">학교(본인 입력): {{ shared.schoolLabel }}</p>
      </header>

      <PortfolioView :view="shared" id-prefix="share" />

      <footer class="public-footer small">
        <p>
          이 페이지는 학생이 보낸 제한 공유 링크로만 열리며 검색엔진에 노출되지 않습니다. 링크는 {{ formatDateTime(shared.expiresAt) }}에 만료되고,
          학생이 언제든 철회할 수 있습니다. 열람은 횟수만 세며 누가 봤는지는 기록하지 않습니다.
        </p>
        <p class="muted">
          케이스 스터디의 출처 칩은 동의를 받아 공개된 사례 기록으로 이어집니다. 원본 사례가 철회되면 그 케이스는 바로 닫힙니다.
          포트폴리오 판 v{{ shared.edition.version }} · {{ formatDateTime(shared.edition.createdAt) }}
        </p>
      </footer>
    </article>
  </div>
</template>
