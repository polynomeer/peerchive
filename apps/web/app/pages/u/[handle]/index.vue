<script setup lang="ts">
/**
 * 공개 프로필(T-02, T-14, PROOFU_EVOLUTION_PLAN §10.1·§11·§13.2 "공개 프로필", DELIVERY_PLAN 시나리오 I). 로그인 없이 봅니다.
 * - 공개 조회 API(`/api/v1/public/profiles/:handle`)만 부르고(쿠키를 넘기지 않는 `$fetch`), 로그인 상태를 읽지 않는 공개 레이아웃을 씁니다:
 *   보는 사람의 이름·이메일이 HTML·payload에 들어가지 않습니다.
 * - 지금 포트폴리오 판만: 한 줄 소개·관심 직무·연락 정책(이메일 없음, 연락 기능은 준비 중)·대표 케이스(요약 보기 + 출처 칩)·역량 × 근거·
 *   후배 기여 개수·4년 타임라인. 원본 사례가 철회·대체된 케이스는 "원본 사례를 더 이상 볼 수 없습니다"만.
 * - Open Graph는 이름과 한 줄 소개만 씁니다. 파일럿 동안 기본 noindex.
 * - 신고(T-15): 프로필 또는 볼 수 있는 대표 케이스(앵커 case-N로 가리킴, 내부 id 없음). 로그인 후.
 * - 페르소나(S-01, ADR 0028): handle은 실명·표시명 프로필 어느 쪽이든 됩니다. 상대 프로필 링크는 본인이 연결을 켰을 때만 공개 API가
 *   `linkedPersona`로 주며, 이 화면은 그 필드 말고는 상대 프로필을 알 길이 없습니다(HTML·payload·OG에 0건). 표시명 프로필에는 대표 케이스·
 *   타임라인·후배 기여가 없고, 표시명 프로필 신고는 S-07에서 엽니다.
 * - 과제 수행 목록(S-03, ADR 0031): 공개 API는 늘 비로그인으로 판정하므로 SSR에는 전체 공개일 때만 들어갑니다. 그렇지 않으면 화면이 뜬 뒤
 *   브라우저에서만 `/api/v1/profiles/:handle`(세션을 읽음)을 불러 로그인·같은 기관·본인 범위의 목록을 붙입니다 — 보는 사람에 따라 달라지는
 *   내용이 SSR HTML·payload에 들어가지 않습니다. 과목·학기·제목만, 엠바고 중이면 제목 없이.
 * - 팔로우·차단·뮤트(S-04, ADR 0033): `ProfileSocial`이 화면이 뜬 뒤 브라우저에서만 세션을 읽는 관계 API를 부릅니다. 차단당한 사용자에게는 그 API가
 *   404이고, 이 화면은 "프로필을 찾을 수 없습니다"로 바뀝니다(공개 경로 자체는 쿠키를 읽지 않으므로 로그아웃한 방문자와 같은 SSR 응답).
 * - 소셜 링크(S-06, ADR 0034): 그 페르소나의 링크와 `링크 확인됨` 배지(인물 검증이 아니라는 설명과 함께). 프로필 기본 정보라 SSR에 늘 들어갑니다.
 */
import type { PublicPortfolioProfileDto, PublicProfileWithProjectsDto, PublicProjectListingDto } from '~~/shared/types/api'
import type { ReportChoice } from '~/utils/moderation'

definePageMeta({ layout: 'public' })

const route = useRoute()
const handle = computed(() => String(route.params.handle))
const { data: profile, error } = await useAsyncData(
  () => `public-profile:${handle.value}`,
  () => $fetch<PublicPortfolioProfileDto>(`/api/v1/public/profiles/${encodeURIComponent(handle.value)}`),
)

const status = computed(() => ((error.value as { statusCode?: number } | null)?.statusCode === 503 ? 503 : 404))
// 차단당한 로그인 사용자(브라우저에서 관계 API가 404): 화면을 "찾을 수 없음"으로 바꿉니다.
const hiddenForViewer = ref(false)
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

const reportTargets = computed<ReportChoice[]>(() => {
  const p = profile.value
  if (!p || p.kind !== 'real') return []
  return [
    { id: 'profile', label: `공개 프로필 @${p.handle}`, targetType: 'profile', targetRef: { handle: p.handle } },
    ...p.featured
      .filter((f) => f.available)
      .map((f) => ({
        id: f.anchor,
        label: `케이스 스터디: ${f.available ? f.title : ''}`,
        targetType: 'case_study' as const,
        targetRef: { handle: p.handle, anchor: f.anchor },
      })),
  ]
})

// 과제 수행 목록: SSR(비로그인 판정)에 없으면 브라우저에서 보는 사람 기준으로 한 번 더 묻습니다.
const viewerProjects = ref<PublicProjectListingDto[] | null>(null)
onMounted(async () => {
  if (!profile.value || profile.value.projects !== null || profile.value.kind !== 'real') return
  try {
    const res = await $fetch<PublicProfileWithProjectsDto>(`/api/v1/profiles/${encodeURIComponent(profile.value.handle)}`)
    viewerProjects.value = res.projects
  } catch (e) {
    viewerProjects.value = null
    if (apiError(e).status === 404) hiddenForViewer.value = true
  }
})
const projects = computed(() => profile.value?.projects ?? viewerProjects.value)

const years = computed(() => {
  const groups = new Map<number, PublicPortfolioProfileDto['timeline']>()
  for (const item of profile.value?.timeline ?? []) groups.set(item.year, [...(groups.get(item.year) ?? []), item])
  return [...groups.entries()]
})
</script>

<template>
  <div>
    <template v-if="error || !profile || hiddenForViewer">
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
        <p v-if="profile.kind === 'display'" class="small muted">표시명 프로필</p>
        <p v-if="profile.linkedPersona" class="small">
          {{ profile.linkedPersona.kind === 'real' ? '실명 프로필' : '표시명 프로필' }}:
          <NuxtLink :to="`/u/${profile.linkedPersona.handle}`">{{ profile.linkedPersona.displayName }} @{{ profile.linkedPersona.handle }}</NuxtLink>
          <span class="muted"> · 본인이 두 프로필의 연결을 공개했습니다.</span>
        </p>
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
        <ul v-if="profile.affiliationBadges.length" class="plain actions small" aria-label="학교 인증">
          <li v-for="badge in profile.affiliationBadges" :key="badge.label"><span class="badge">✓ {{ badge.label }}</span></li>
        </ul>
        <ProfileSocialLinks :links="profile.socialLinks" />
      </header>

      <ClientOnly><ProfileSocial :handle="profile.handle" @hidden="hiddenForViewer = true" /></ClientOnly>

      <PortfolioView :view="profile" id-prefix="pf" />

      <section v-if="profile.kind === 'real'" aria-labelledby="junior-heading">
        <h2 id="junior-heading">후배 기여</h2>
        <p>
          공개한 계획을 포크한 사람 {{ profile.juniorContribution.planForks }}명 · 이름으로 남긴 선배 노트 {{ profile.juniorContribution.seniorNotes }}개
        </p>
        <p class="hint">개수만 보여 주며 순위를 매기지 않습니다.</p>
      </section>

      <section v-if="projects && projects.length" aria-labelledby="projects-heading">
        <h2 id="projects-heading">과제 수행 목록</h2>
        <ul class="small">
          <li v-for="(p, i) in projects" :key="i">
            <template v-if="p.courseTitle">{{ p.courseTitle }}</template><template v-else>과목 미연결 과제</template>
            <template v-if="p.termLabel"> · {{ p.termLabel }}</template>
            <template v-if="p.title"> · {{ p.title }}</template>
            <span v-else class="muted"> · 제목 비공개 기간(엠바고)</span>
          </li>
        </ul>
        <p class="hint">본인이 고른 과제의 과목·학기·제목만 보입니다. 과제 기록은 공개 사례로 게시된 것만 볼 수 있습니다.</p>
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
        <p v-if="reportTargets.length">문제가 있는 내용이 있나요? <ReportButton :targets="reportTargets" id-prefix="profile" label="신고하기" /></p>
      </footer>
    </article>
  </div>
</template>
