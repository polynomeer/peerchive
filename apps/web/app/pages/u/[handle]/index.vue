<script setup lang="ts">
/**
 * 공개 프로필(T-02, T-14, PROOFU_EVOLUTION_PLAN §10.1·§11·§13.2 "공개 프로필", DELIVERY_PLAN 시나리오 I). 로그인 없이 봅니다.
 * - 공개 조회 API(`/api/v1/public/profiles/:handle`)만 부르고(쿠키를 넘기지 않는 `$fetch`), 로그인 상태를 읽지 않는 공개 레이아웃을 씁니다:
 *   보는 사람의 이름·이메일이 HTML·payload에 들어가지 않습니다.
 * - 지금 포트폴리오 판만: 한 줄 소개·관심 직무·연락 정책(이메일 없음, 연락 기능은 준비 중)·대표 케이스(요약 보기 + 출처 칩)·역량 × 근거·
 *   후배 기여 개수·4년 타임라인. 원본 사례가 철회·대체된 케이스는 "원본 사례를 더 이상 볼 수 없습니다"만.
 * - Open Graph는 이름과 한 줄 소개만 씁니다. 파일럿 동안 기본 noindex.
 */
import type { PublicPortfolioProfileDto } from '~~/shared/types/api'

definePageMeta({ layout: 'public' })

const route = useRoute()
const handle = computed(() => String(route.params.handle))
const { data: profile, error } = await useAsyncData(
  () => `public-profile:${handle.value}`,
  () => $fetch<PublicPortfolioProfileDto>(`/api/v1/public/profiles/${encodeURIComponent(handle.value)}`),
)

const status = computed(() => ((error.value as { statusCode?: number } | null)?.statusCode === 503 ? 503 : 404))
const indexing = usePublicIndexing()
const indexable = computed(() => indexing.value && !!profile.value)
if (import.meta.server) {
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  if (!indexable.value) useResponseHeader('x-robots-tag').value = 'noindex, nofollow'
  const event = useRequestEvent()
  if (event && error.value) setResponseStatus(event, status.value)
}

const headline = computed(() => {
  const text = profile.value?.headline?.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
})
useSeoMeta({
  title: () => (profile.value ? `${profile.value.displayName} (@${profile.value.handle}) — Peerchive` : '프로필 — Peerchive'),
  description: () => headline.value || undefined,
  ogTitle: () => (profile.value ? `${profile.value.displayName} — Peerchive 포트폴리오` : undefined),
  ogDescription: () => headline.value || undefined,
  ogType: 'profile',
  ogSiteName: 'Peerchive',
  robots: () => (indexable.value ? 'index, follow' : 'noindex, nofollow'),
})

const years = computed(() => {
  const groups = new Map<number, PublicPortfolioProfileDto['timeline']>()
  for (const item of profile.value?.timeline ?? []) groups.set(item.year, [...(groups.get(item.year) ?? []), item])
  return [...groups.entries()]
})
</script>

<template>
  <div>
    <template v-if="error || !profile">
      <template v-if="status === 503">
        <h1>잠시 공개 페이지를 볼 수 없습니다</h1>
        <p>점검 중입니다. 잠시 뒤 다시 열어 주세요.</p>
      </template>
      <template v-else>
        <h1>프로필을 찾을 수 없습니다</h1>
        <p>주소를 확인하세요.</p>
      </template>
    </template>
    <article v-else class="profile-page" aria-labelledby="profile-name">
      <header class="profile-header">
        <h1 id="profile-name">{{ profile.displayName }} <span class="muted">@{{ profile.handle }}</span></h1>
        <p v-if="profile.jobTargets.length || profile.gradTerm" class="small">
          <template v-if="profile.jobTargets.length">{{ profile.jobTargets.join(', ') }} 지망</template>
          <template v-if="profile.gradTerm"> · {{ profile.gradTerm }} 졸업(예정)</template>
        </p>
        <p v-if="profile.headline" class="profile-headline">“{{ profile.headline }}”</p>
        <p class="actions small">
          <span v-if="profile.openToWork" class="badge">구직 중</span>
          <span>연락: {{ profile.contactText }}</span>
        </p>
        <p class="actions small">
          <NuxtLink :to="`/u/${profile.handle}/print`">인쇄용 보기 / PDF로 저장</NuxtLink>
          <a :href="`/api/v1/public/profiles/${profile.handle}/readme-card.md`">GitHub README 카드(마크다운)</a>
        </p>
        <p v-if="profile.schoolLabel" class="small muted">학교(본인 입력): {{ profile.schoolLabel }}</p>
      </header>

      <PortfolioView :view="profile" id-prefix="pf" />

      <section aria-labelledby="junior-heading">
        <h2 id="junior-heading">후배 기여</h2>
        <p>
          공개한 계획을 포크한 사람 {{ profile.juniorContribution.planForks }}명 · 이름으로 남긴 선배 노트 {{ profile.juniorContribution.seniorNotes }}개
        </p>
        <p class="hint">개수만 보여 주며 순위를 매기지 않습니다.</p>
      </section>

      <section v-if="years.length" aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">과제 타임라인</h2>
        <ol class="profile-timeline">
          <li v-for="[year, items] in years" :key="year">
            <strong>{{ year }}</strong>
            <ul class="small">
              <li v-for="item in items" :key="item.path">
                <span v-if="item.termLabel" class="muted">{{ item.termLabel }} · </span><NuxtLink :to="item.path">{{ item.title }}</NuxtLink>
              </li>
            </ul>
          </li>
        </ol>
      </section>

      <footer class="public-footer small">
        <p>
          케이스 스터디의 모든 문장은 학생이 고르고 고친 글이며, 출처 칩은 동의를 받아 공개된 사례 기록으로 이어집니다.
          원본 사례가 철회되면 그 케이스는 바로 닫힙니다. 팀원 확인은 팀원이 선언을 인정했다는 뜻이며 능력 인증이 아닙니다.
        </p>
        <p v-if="profile.edition" class="muted">포트폴리오 판 v{{ profile.edition.version }} · {{ formatDateTime(profile.edition.createdAt) }}</p>
      </footer>
    </article>
  </div>
</template>
