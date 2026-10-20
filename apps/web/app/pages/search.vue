<script setup lang="ts">
/**
 * 공개 검색(T-13, SYSTEM_DESIGN §11.1). 로그인 없이 봅니다. 공개 검색 API만 부르고(쿠키 없음), 결과는 지금 게시 중인 사례·막힘과
 * 게시된 선배 노트뿐입니다(서버가 매 요청 공개 상태와 조인). 탭으로 종류를 고르고, `course=`로 과목 안에서 찾습니다. 기본 noindex.
 */
import type { PublicSearchDto, SearchKind } from '~~/shared/types/api'

definePageMeta({ layout: 'public' })

const route = useRoute()
const q = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const type = computed<SearchKind | ''>(() =>
  route.query.type === 'case' || route.query.type === 'stuck' || route.query.type === 'note' ? route.query.type : '',
)
const course = computed(() => (typeof route.query.course === 'string' ? route.query.course : ''))

const { data, error } = await useAsyncData(
  () => `public-search:${q.value}:${type.value}:${course.value}`,
  () =>
    q.value.trim()
      ? $fetch<PublicSearchDto>('/api/v1/public/search', { query: { q: q.value, type: type.value || undefined, course: course.value || undefined } })
      : Promise.resolve(null),
  { watch: [q, type, course] },
)

if (import.meta.server) {
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  useResponseHeader('x-robots-tag').value = 'noindex, nofollow'
}
useSeoMeta({ title: () => (q.value ? `“${q.value}” 검색 — Peerchive` : '검색 — Peerchive'), robots: 'noindex, nofollow' })

const draft = ref(q.value)
watch(q, (value) => (draft.value = value))

const TABS: Array<{ value: SearchKind | ''; label: string }> = [
  { value: '', label: '전체' },
  { value: 'case', label: SEARCH_KIND_LABELS.case },
  { value: 'stuck', label: SEARCH_KIND_LABELS.stuck },
  { value: 'note', label: SEARCH_KIND_LABELS.note },
]
const tabQuery = (value: SearchKind | '') => ({ q: q.value || undefined, type: value || undefined, course: course.value || undefined })

function submit() {
  void navigateTo({ path: '/search', query: { q: draft.value.trim() || undefined, type: type.value || undefined, course: course.value || undefined } })
}
const errorMessage = computed(() => {
  const status = (error.value as { statusCode?: number } | null)?.statusCode
  if (!error.value) return ''
  return status === 503 ? '잠시 검색을 쓸 수 없습니다. 잠시 뒤 다시 시도하세요.' : '검색어를 확인하세요(100자 이하).'
})
</script>

<template>
  <div>
    <h1>검색</h1>
    <form class="hub-search" role="search" @submit.prevent="submit">
      <label class="visually-hidden" for="search-q">검색어</label>
      <input id="search-q" v-model="draft" type="search" name="q" maxlength="100" placeholder="과목명·막힘 증상·키워드" />
      <button type="submit">검색</button>
    </form>
    <p v-if="course" class="small muted">한 과목 안에서 찾는 중입니다. <NuxtLink :to="{ path: '/search', query: { q: q || undefined, type: type || undefined } }">모든 과목에서 찾기</NuxtLink></p>

    <nav aria-label="결과 종류" class="chips filter">
      <NuxtLink
        v-for="tab in TABS"
        :key="tab.value || 'all'"
        :to="{ path: '/search', query: tabQuery(tab.value) }"
        class="chip"
        :class="{ selected: tab.value === type }"
        :aria-current="tab.value === type ? 'page' : undefined"
      >
        {{ tab.label }}
      </NuxtLink>
    </nav>

    <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!q.trim()" class="muted">공개 사례·막힘·선배 노트에서 찾습니다. 공개된 내용만 나옵니다.</p>
    <template v-else-if="data">
      <p class="small muted" role="status">결과 {{ data.results.length }}건</p>
      <ul v-if="data.results.length" class="plain hub-list">
        <li v-for="(r, i) in data.results" :key="`${r.path}:${i}`" class="hub-card">
          <p class="small muted"><span class="badge">{{ SEARCH_KIND_LABELS[r.kind] }}</span><template v-if="r.course"> · {{ r.course.schoolName }} · {{ r.course.title }}</template></p>
          <p class="hub-card-title"><NuxtLink :to="r.path">{{ r.title }}</NuxtLink></p>
          <p v-if="r.snippet" class="small">{{ r.snippet }}</p>
        </li>
      </ul>
      <p v-else class="muted">찾은 결과가 없습니다. 다른 낱말로 찾아보세요.</p>
    </template>
  </div>
</template>
