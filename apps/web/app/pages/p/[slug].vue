<script setup lang="ts">
/**
 * 공개 사례 페이지(T-12, PROOFU_EVOLUTION_PLAN §13.2 "공개 사례", SYSTEM_DESIGN §1-1). 로그인 없이 봅니다.
 * - 공개 조회 API(`/api/v1/public/publications/:slug`)의 저장된 스냅샷만으로 PublicSnapshotView가 그립니다. 비공개 API를 부르지 않습니다.
 * - SSR에서 쿠키를 넘기지 않고(`$fetch`), 레이아웃도 로그인 상태를 읽지 않습니다(HTML·payload에 보는 사람의 정보 없음).
 * - Open Graph는 스냅샷의 제목·요약만 씁니다. 파일럿 동안 기본 noindex(서버 설정으로 바꿈).
 * - T-13: 과목 허브 링크, 계획 포크 수와 "이 계획 포크하기"(로그인 여부는 화면이 뜬 뒤 클라이언트에서만 확인).
 */
import type { PlanForkResultDto, PublicPublicationDto } from '~~/shared/types/api'

definePageMeta({ layout: 'public' })

const route = useRoute()
const slug = computed(() => String(route.params.slug))

const { data, error } = await useAsyncData(
  () => `public-publication:${slug.value}`,
  () => $fetch<PublicPublicationDto>(`/api/v1/public/publications/${encodeURIComponent(slug.value)}`),
)

const status = computed(() => {
  const code = (error.value as { statusCode?: number } | null)?.statusCode
  return code === 503 ? 503 : 404
})
const indexing = usePublicIndexing()
const indexable = computed(() => indexing.value && !!data.value)
if (import.meta.server) {
  // 철회 뒤에 저장된 HTML이 다시 보이지 않도록 캐시하지 않습니다(공개 조회 API와 같은 no-store).
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  if (!indexable.value) useResponseHeader('x-robots-tag').value = 'noindex, nofollow'
  const event = useRequestEvent()
  if (event && error.value) setResponseStatus(event, status.value)
}

const description = computed(() => {
  const text = data.value?.snapshot.summary.replace(/\s+/g, ' ').trim() ?? ''
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
})
useSeoMeta({
  title: () => (data.value ? `${data.value.snapshot.title} — Peerchive` : '공개 사례 — Peerchive'),
  description: () => description.value || undefined,
  ogTitle: () => data.value?.snapshot.title,
  ogDescription: () => description.value || undefined,
  ogType: 'article',
  ogSiteName: 'Peerchive',
  robots: () => (indexable.value ? 'index, follow' : 'noindex, nofollow'),
})

// 계획 포크(T-13): 마일스톤 이름·순서와 참고 링크만 내 새 비공개 과제로 복사합니다.
const loggedIn = ref<boolean | null>(null)
const forking = ref(false)
const forkMessage = ref('')
onMounted(async () => {
  loggedIn.value = !!(await useAuth().ensure())
})
async function fork() {
  forkMessage.value = ''
  forking.value = true
  try {
    const result = await $fetch<PlanForkResultDto>(`/api/v1/public/publications/${encodeURIComponent(slug.value)}/fork`, { method: 'POST' })
    await navigateTo(result.projectPath)
  } catch (error) {
    forkMessage.value = courseHubErrorMessage(apiError(error).code)
  } finally {
    forking.value = false
  }
}

const fileUrl = (versionId: string) =>
  `/api/v1/public/publications/${encodeURIComponent(slug.value)}/artifacts/${encodeURIComponent(versionId)}`
</script>

<template>
  <div>
    <template v-if="error || !data">
      <template v-if="status === 503">
        <h1>잠시 공개 페이지를 볼 수 없습니다</h1>
        <p>점검 중입니다. 잠시 뒤 다시 열어 주세요.</p>
      </template>
      <template v-else>
        <h1>공개 사례를 찾을 수 없습니다</h1>
        <p>주소가 틀렸거나, 공개가 철회되었거나, 아직 공개되지 않았습니다.</p>
      </template>
    </template>
    <template v-else>
      <p class="public-meta small muted">
        <span>공개 버전 v{{ data.version }}</span>
        <span>게시일 {{ formatDateTime(data.publishedAt) }}</span>
        <span v-if="data.firstPublishedAt !== data.publishedAt">처음 게시 {{ formatDateTime(data.firstPublishedAt) }}</span>
      </p>
      <p v-if="data.courseId" class="small"><NuxtLink :to="`/c/${data.courseId}`">이 과목의 다른 사례·막힘·선배 노트 보기</NuxtLink></p>
      <PublicSnapshotView :snapshot="data.snapshot" :file-url="data.level === 'full' ? fileUrl : undefined" id-prefix="public" />
      <section class="fork-box" aria-labelledby="fork-title">
        <h2 id="fork-title">이 계획으로 시작하기</h2>
        <p class="small">
          마일스톤 이름·순서와 참고 링크만 내 새 비공개 과제로 복사합니다. 기록·해결 방법·파일·사람 이름은 복사하지 않습니다.
          <template v-if="data.forkCount"> 지금까지 {{ data.forkCount }}명이 이 계획을 포크했습니다.</template>
        </p>
        <p class="actions">
          <button v-if="loggedIn" type="button" :disabled="forking" @click="fork">이 계획 포크하기</button>
          <span v-else-if="loggedIn === false" class="small"><NuxtLink to="/login">로그인</NuxtLink>하면 이 계획을 포크할 수 있어요.</span>
        </p>
        <p v-if="forkMessage" class="field-error" role="alert">{{ forkMessage }}</p>
      </section>
      <footer class="public-footer small">
        <p>
          이 사례는 학생이 고른 기록만 담은 공개 스냅샷이며, 함께한 사람의 동의를 받아 게시되었습니다. 당사자는 언제든 공개를 철회할 수 있고,
          철회하면 이 페이지와 파일은 바로 닫힙니다. 다만 이미 내려받은 사본이나 외부 검색엔진·다른 사이트에 남은 사본은 회수를 보장할 수 없습니다.
        </p>
        <p>
          <!-- 신고 기능은 T-15에서 연결합니다. -->
          <span aria-disabled="true" class="muted">신고하기(준비 중)</span>
        </p>
      </footer>
    </template>
  </div>
</template>
