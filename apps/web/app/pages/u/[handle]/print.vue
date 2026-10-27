<script setup lang="ts">
/**
 * 공개 프로필 인쇄 보기(T-14, PROOFU_EVOLUTION_PLAN §10.6 "기본 인쇄 보기", ADR 0008의 인쇄 방식). A4, 사이트 머리글 없음(layout 없음).
 * 브라우저의 인쇄 → "PDF로 저장"으로 PDF를 만듭니다(서버 PDF 생성 없음).
 * - 공개 프로필과 같은 공개 조회 API만 부릅니다(쿠키 없음). 그래서 인쇄물에도 공개 프로필에 없는 정보(이메일·내부 id·비공개 기록)가 없습니다.
 * - 링크는 종이에서도 따라갈 수 있게 주소를 함께 적습니다.
 * - 상대 페르소나(S-01)는 본인이 연결을 켰을 때만(`linkedPersona`) 주소를 적습니다. 꺼져 있으면 인쇄물에도 0건입니다.
 * - 과제 수행 목록(S-03)은 공개 API가 싣는 경우(전체 공개)에만 적습니다. 인쇄물은 로그인 상태를 반영하지 않습니다.
 * - 소셜 링크(S-06)는 주소와 `링크 확인됨` 표시·설명(인물 검증 아님)을 함께 적습니다.
 */
import type { PublicPortfolioProfileDto } from '~~/shared/types/api'

definePageMeta({ layout: false })

const route = useRoute()
const handle = computed(() => String(route.params.handle))
const { data: profile, error } = await useAsyncData(
  () => `public-profile-print:${handle.value}`,
  () => $fetch<PublicPortfolioProfileDto>(`/api/v1/public/profiles/${encodeURIComponent(handle.value)}`),
)
if (import.meta.server) {
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  useResponseHeader('x-robots-tag').value = 'noindex, nofollow'
  const event = useRequestEvent()
  if (event && error.value) setResponseStatus(event, (error.value as { statusCode?: number }).statusCode === 503 ? 503 : 404)
}
useHead({
  title: () => (profile.value ? `${profile.value.displayName} 포트폴리오(인쇄용) — Peerchive` : '포트폴리오 — Peerchive'),
  meta: [{ name: 'robots', content: 'noindex, nofollow' }],
})
const printPage = () => window.print()
</script>

<template>
  <div class="report-shell portfolio-print">
    <nav class="report-toolbar no-print" aria-label="인쇄 도구">
      <NuxtLink :to="`/u/${handle}`">← 공개 프로필로 돌아가기</NuxtLink>
      <button v-if="profile" type="button" @click="printPage">인쇄 / PDF로 저장</button>
    </nav>
    <main id="main" class="report">
      <template v-if="error || !profile">
        <h1>프로필을 찾을 수 없습니다</h1>
        <p>주소를 확인하세요.</p>
      </template>
      <template v-else>
        <header class="report-header">
          <p class="report-kicker">Peerchive 포트폴리오</p>
          <h1>{{ profile.displayName }} <span class="report-muted">@{{ profile.handle }}</span></h1>
          <p v-if="profile.linkedPersona" class="report-small">
            {{ profile.linkedPersona.kind === 'real' ? '실명 프로필' : '표시명 프로필' }}: {{ profile.linkedPersona.displayName }} @{{ profile.linkedPersona.handle }} (/u/{{ profile.linkedPersona.handle }})
          </p>
          <p v-if="profile.jobTargets.length">{{ profile.jobTargets.join(', ') }} 지망<template v-if="profile.gradTerm"> · {{ profile.gradTerm }} 졸업(예정)</template></p>
          <p v-if="profile.headline"><strong>“{{ profile.headline }}”</strong></p>
          <p class="report-small">연락: {{ profile.contactText }}</p>
        </header>
        <ProfileSocialLinks :links="profile.socialLinks" print />
        <PortfolioView :view="profile" print id-prefix="print" />
        <section v-if="profile.projects && profile.projects.length" class="report-member">
          <h2>과제 수행 목록</h2>
          <ul class="report-small">
            <li v-for="(p, i) in profile.projects" :key="i">
              {{ p.courseTitle ?? '과목 미연결 과제' }}<template v-if="p.termLabel"> · {{ p.termLabel }}</template><template v-if="p.title"> · {{ p.title }}</template><template v-else> · 제목 비공개 기간(엠바고)</template>
            </li>
          </ul>
        </section>
        <section v-if="profile.timeline.length" class="report-member">
          <h2>과제 타임라인</h2>
          <ul class="report-small">
            <li v-for="item in profile.timeline" :key="item.path">{{ item.year }} · <template v-if="item.termLabel">{{ item.termLabel }} · </template>{{ item.title }} ({{ item.path }})</li>
          </ul>
        </section>
        <footer class="report-footer">
          <p>모든 문장의 출처는 동의를 받아 공개된 사례 기록입니다. 원본 사례가 철회되면 온라인 프로필에서 바로 닫히지만, 이미 인쇄·저장한 사본은 회수되지 않습니다.</p>
          <p class="report-muted">
            온라인 프로필: /u/{{ profile.handle }}<template v-if="profile.edition"> · 포트폴리오 판 v{{ profile.edition.version }}</template> · 점수·순위를 매기지 않습니다.
          </p>
        </footer>
      </template>
    </main>
  </div>
</template>
