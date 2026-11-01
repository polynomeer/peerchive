<script setup lang="ts">
/**
 * 포트폴리오(T-14, PROOFU_EVOLUTION_PLAN §10·§13.1 "포트폴리오 [케이스 스터디 | 프로필 | 내보내기]").
 * - 케이스 스터디 만들기: 내가 팀원으로 들어 있는 지금 게시 중인 공개 사례 → 지원 직무 고르기 → 템플릿 초안(모든 문장에 출처).
 *   익명으로 나오는 사례는 내 프로필과 연결된다는 경고를 보고 확인해야 만들 수 있습니다.
 * - 내 케이스 스터디: 상태(초안·게시·볼 수 없음), 출처 없는 문장 수, 원본이 바뀌면 "새 버전으로 다시 만들기".
 * - 포트폴리오 판과 내보내기(공개 프로필·인쇄 보기·README 카드). 지금 판의 제한 공유 링크(E-07, ADR 0051)는 `ShareLinksSection`.
 */
import type { CaseJobTarget, CaseStudyDto, CaseStudySourceDto, CaseStudySummaryDto, PortfolioEditionDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '포트폴리오 — Peerchive' })

const { me } = useAuth()
const requestFetch = useRequestFetch()
const { data: sources, refresh: refreshSources } = await useAsyncData('case-study-sources', () => requestFetch<CaseStudySourceDto[]>('/api/v1/me/case-study-sources'))
const { data: mine, refresh: refreshMine } = await useAsyncData('my-case-studies', () => requestFetch<CaseStudySummaryDto[]>('/api/v1/me/case-studies'))
const { data: editions } = await useAsyncData('my-portfolio-editions', () => requestFetch<PortfolioEditionDto[]>('/api/v1/me/portfolio-editions'))

const choices = reactive<Record<string, { jobTarget: CaseJobTarget; reveal: boolean }>>({})
const choiceFor = (slug: string) => (choices[slug] ??= { jobTarget: 'general', reveal: false })
const busy = ref<string | null>(null)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function create(slug: string, jobTarget: CaseJobTarget, revealSelf: boolean) {
  busy.value = slug
  message.value = null
  try {
    const dto = await $fetch<CaseStudyDto>('/api/v1/case-studies', { method: 'POST', body: { releaseSlug: slug, jobTarget, revealSelf } })
    await navigateTo(`/portfolio/case-studies/${dto.id}`)
  } catch (error) {
    const e = apiError(error)
    message.value = { kind: 'error', text: e.status === 422 ? (fieldText(Object.values(e.fields)[0]) ?? '입력을 확인하세요.') : portfolioErrorMessage(e.code) }
    await Promise.all([refreshSources(), refreshMine()])
  } finally {
    busy.value = null
  }
}

// 채용자용 기본은 실명 프로필의 판입니다(S-01). 표시명 프로필의 판은 /settings/personas에서.
const realEditions = computed(() => (editions.value ?? []).filter((e) => e.persona.kind === 'real'))
const currentEdition = computed(() => realEditions.value.find((e) => e.current) ?? null)
</script>

<template>
  <div>
    <h1>포트폴리오</h1>
    <p class="hint">
      공개된 과제 사례에서 케이스 스터디 초안을 만들고, 고친 뒤 게시해 포트폴리오 판에 넣습니다. 초안은 공개 스냅샷의 기록만으로 만들며
      모든 문장에 출처가 붙습니다. 지어낸 사실이나 숫자는 넣지 않습니다.
    </p>
    <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>

    <section aria-labelledby="sources-heading">
      <h2 id="sources-heading">케이스 스터디 만들기</h2>
      <p v-if="!sources?.length" class="muted">
        아직 내가 팀원으로 들어 있는 공개 사례가 없습니다. 과제 화면의 "공개 준비"에서 사례를 공개하면 여기에 나옵니다.
      </p>
      <ul v-else class="plain hub-list">
        <li v-for="s in sources" :key="s.slug" class="hub-card">
          <p class="hub-card-title"><NuxtLink :to="s.path">{{ s.title }}</NuxtLink></p>
          <p class="small muted">
            공개 버전 v{{ s.releaseVersion }}<template v-if="s.termLabel"> · {{ s.termLabel }}</template> · 사례 속 내 표시: {{ s.selfLabel }}<template v-if="s.selfAnonymous"> (익명)</template>
          </p>
          <p v-if="s.caseStudies.length" class="small">이 사례로 만든 케이스: {{ s.caseStudies.map((c) => CASE_JOB_TARGET_LABELS[c.jobTarget]).join(', ') }}</p>
          <form class="stack" @submit.prevent="create(s.slug, choiceFor(s.slug).jobTarget, choiceFor(s.slug).reveal)">
            <div class="field">
              <label :for="`job-${s.slug}`">지원 직무(강조할 구역 순서)</label>
              <select :id="`job-${s.slug}`" v-model="choiceFor(s.slug).jobTarget">
                <option v-for="t in CASE_JOB_TARGETS" :key="t" :value="t">{{ CASE_JOB_TARGET_LABELS[t] }}</option>
              </select>
            </div>
            <div v-if="s.selfAnonymous" class="notice" role="note">
              <p class="small">{{ REVEAL_SELF_WARNING }}</p>
              <label class="check small">
                <input v-model="choiceFor(s.slug).reveal" type="checkbox" />
                이해했고, 이 사례의 익명 표시({{ s.selfLabel }})를 내 프로필과 연결합니다.
              </label>
            </div>
            <p class="actions">
              <button type="submit" :disabled="busy === s.slug || (s.selfAnonymous && !choiceFor(s.slug).reveal)">케이스 스터디 만들기</button>
            </p>
          </form>
        </li>
      </ul>
    </section>

    <section aria-labelledby="mine-heading">
      <h2 id="mine-heading">내 케이스 스터디</h2>
      <p v-if="!mine?.length" class="muted">아직 만든 케이스 스터디가 없습니다.</p>
      <ul v-else class="plain hub-list">
        <li v-for="c in mine" :key="c.id" class="hub-card">
          <p class="hub-card-title">
            <NuxtLink v-if="c.status !== 'unavailable'" :to="`/portfolio/case-studies/${c.id}`">{{ c.title }}</NuxtLink>
            <span v-else>{{ c.title }}</span>
          </p>
          <p class="small">
            <span class="badge">{{ CASE_STATUS_LABELS[c.status] }}</span>
            · {{ CASE_JOB_TARGET_LABELS[c.jobTarget] }} 관점 · 공개 버전 v{{ c.source.releaseVersion }}
            <template v-if="c.uncitedCount && c.status !== 'unavailable'"> · <strong>출처 없는 문장 {{ c.uncitedCount }}개</strong></template>
          </p>
          <template v-if="c.status === 'unavailable'">
            <p class="small">원본 사례를 더 이상 볼 수 없습니다. <span v-if="c.unavailableReason" class="muted">({{ CASE_UNAVAILABLE_LABELS[c.unavailableReason] }})</span></p>
            <p v-if="c.recreateSlug" class="actions">
              <button type="button" class="secondary" :disabled="busy === c.recreateSlug" @click="create(c.recreateSlug, c.jobTarget, false)">새 버전으로 다시 만들기</button>
            </p>
          </template>
        </li>
      </ul>
    </section>

    <section aria-labelledby="edition-heading">
      <h2 id="edition-heading">포트폴리오 판</h2>
      <p class="hint">게시한 케이스 스터디 중 최대 5개와 역량 × 근거를 골라 판을 만들면 공개 프로필에 그 판이 보입니다. 판은 만든 뒤 바꾸지 않고, 새로 만들면 새 판이 지금 판이 됩니다.</p>
      <p v-if="currentEdition" class="small">지금 판: v{{ currentEdition.version }} · {{ formatDateTime(currentEdition.createdAt) }} · 대표 케이스 {{ currentEdition.featured.length }}개</p>
      <p class="actions">
        <NuxtLink to="/portfolio/edition">새 판 만들기</NuxtLink>
      </p>
      <details v-if="realEditions.length > 1">
        <summary>이전 판 {{ realEditions.length - 1 }}개(공개하지 않음)</summary>
        <ul class="small">
          <li v-for="e in realEditions.filter((x) => !x.current)" :key="e.id">v{{ e.version }} · {{ formatDateTime(e.createdAt) }} · {{ e.featured.map((f) => f.title).join(', ') || '대표 케이스 없음' }}</li>
        </ul>
      </details>
      <ShareLinksSection :edition-id="currentEdition?.id ?? null" :edition-version="currentEdition?.version ?? null" />
    </section>

    <section v-if="me?.profile" aria-labelledby="export-heading">
      <h2 id="export-heading">내보내기</h2>
      <ul class="small">
        <li><NuxtLink :to="`/u/${me.profile.handle}`">공개 프로필 보기</NuxtLink> (로그인 없이 누구나 봄)</li>
        <li><NuxtLink :to="`/u/${me.profile.handle}/print`">인쇄용 보기</NuxtLink> — 브라우저 인쇄에서 "PDF로 저장"</li>
        <li>
          <a :href="`/api/v1/public/profiles/${me.profile.handle}/readme-card.md`">GitHub 프로필 README 카드(마크다운)</a> — 내용을 복사해 README에 붙여 넣으세요.
        </li>
      </ul>
    </section>
  </div>
</template>
