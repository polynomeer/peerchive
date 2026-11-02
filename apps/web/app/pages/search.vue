<script setup lang="ts">
/**
 * 공개 검색(T-13, SYSTEM_DESIGN §11.1). 로그인 없이 봅니다. 공개 검색 API만 부르고(쿠키 없음), 결과는 지금 게시 중인 사례·막힘과
 * 게시된 선배 노트뿐입니다(서버가 매 요청 공개 상태와 조인). 탭으로 종류를 고르고, `course=`로 과목 안에서 찾습니다. 기본 noindex.
 * E-05: 임베딩 공급자가 설정되어 있으면(`semanticStuck`) "의미로 찾기"(`mode=semantic`)로 의미가 비슷한 공개 막힘을 찾습니다. 화면이 뜬 뒤
 * 클라이언트에서만 부르고(SSR 없음), 공급자가 꺼져 있으면 토글이 없고 `mode`는 무시되어 키워드 검색 그대로입니다.
 */
import type { PublicSearchDto, PublicSemanticSearchDto, SearchKind } from '~~/shared/types/api'

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

// E-05 의미로 찾기(공급자가 켜져 있을 때만).
const { flags, ensure: ensureFeatures } = useFeatures()
const semantic = computed(() => route.query.mode === 'semantic' && flags.value.semanticStuck)
const semanticData = ref<PublicSemanticSearchDto | null>(null)
const semanticError = ref('')
const semanticLoading = ref(false)
async function loadSemantic() {
  semanticData.value = null
  semanticError.value = ''
  if (!semantic.value || !q.value.trim()) return
  semanticLoading.value = true
  try {
    semanticData.value = await $fetch<PublicSemanticSearchDto>('/api/v1/public/search/semantic', {
      query: { q: q.value, course: course.value || undefined },
    })
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode
    semanticError.value =
      status === 429 ? '의미로 찾기를 너무 자주 썼습니다. 잠시 뒤 다시 시도하거나 키워드로 찾아보세요.' : '지금은 의미로 찾기를 쓸 수 없습니다. 키워드로 찾아보세요.'
  } finally {
    semanticLoading.value = false
  }
}
onMounted(async () => {
  await ensureFeatures()
  watch([q, course, semantic], () => void loadSemantic(), { immediate: true })
})
const modeQuery = (on: boolean) => ({ q: q.value || undefined, course: course.value || undefined, mode: on ? 'semantic' : undefined })

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
  void navigateTo({
    path: '/search',
    query: { q: draft.value.trim() || undefined, type: type.value || undefined, course: course.value || undefined, mode: semantic.value ? 'semantic' : undefined },
  })
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

    <p v-if="flags.semanticStuck" class="chips filter" data-testid="semantic-toggle">
      <NuxtLink :to="{ path: '/search', query: modeQuery(false) }" class="chip" :class="{ selected: !semantic }" :aria-current="!semantic ? 'page' : undefined">
        키워드로 찾기
      </NuxtLink>
      <NuxtLink :to="{ path: '/search', query: modeQuery(true) }" class="chip" :class="{ selected: semantic }" :aria-current="semantic ? 'page' : undefined">
        의미로 찾기(막힘)
      </NuxtLink>
    </p>

    <template v-if="semantic">
      <p class="small muted">검색어와 뜻이 비슷한 공개 막힘을 찾습니다. 검색어는 의미 비교에만 쓰고 저장하지 않습니다.</p>
      <p v-if="semanticError" class="notice error" role="alert">{{ semanticError }}</p>
      <p v-else-if="!q.trim()" class="muted">겪고 있는 막힘을 문장으로 적어 보세요.</p>
      <p v-else-if="semanticLoading" class="small muted" role="status">찾는 중…</p>
      <template v-else-if="semanticData">
        <p class="small muted" role="status">결과 {{ semanticData.results.length }}건</p>
        <ul v-if="semanticData.results.length" class="plain hub-list" data-testid="semantic-results">
          <li v-for="r in semanticData.results" :key="r.path" class="hub-card">
            <p class="small muted"><span class="badge">{{ SEARCH_KIND_LABELS[r.kind] }}</span><template v-if="r.course"> · {{ r.course.schoolName }} · {{ r.course.title }}</template></p>
            <p class="hub-card-title"><NuxtLink :to="r.path">{{ r.title }}</NuxtLink></p>
            <p v-if="r.snippet" class="small">{{ r.snippet }}</p>
          </li>
        </ul>
        <p v-else class="muted">비슷한 막힘을 찾지 못했습니다. 키워드로도 찾아보세요.</p>
      </template>
    </template>

    <template v-else>
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
    </template>
  </div>
</template>
