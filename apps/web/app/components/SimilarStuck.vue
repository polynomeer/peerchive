<script setup lang="ts">
/**
 * 비슷한 막힘(E-05, ADR 0055). 공개 막힘 카드 하나와 의미가 비슷한 다른 공개 막힘을 보여 줍니다.
 * - 임베딩 공급자가 설정된 경우에만 서버가 응답합니다(`flags.semanticStuck`). 부모가 그 값을 보고 이 컴포넌트를 그립니다.
 * - 화면이 뜬 뒤 클라이언트에서만 부릅니다(SSR 없음). `auto`가 아니면 "비슷한 막힘 보기"를 눌렀을 때 불러 요청 한도를 아낍니다.
 * - 결과는 공개 카드와 같은 필드(증상·키워드)와 공개 사례 링크뿐입니다.
 */
import type { SimilarStuckDto } from '~~/shared/types/api'

const props = defineProps<{ slug: string; itemKey: string; auto?: boolean }>()

const state = ref<'idle' | 'loading' | 'done' | 'error'>('idle')
const data = ref<SimilarStuckDto | null>(null)

async function load() {
  state.value = 'loading'
  try {
    data.value = await $fetch<SimilarStuckDto>(
      `/api/v1/public/publications/${encodeURIComponent(props.slug)}/stuck/${encodeURIComponent(props.itemKey)}/similar`,
    )
    state.value = 'done'
  } catch {
    state.value = 'error'
  }
}
onMounted(() => {
  if (props.auto) void load()
})
</script>

<template>
  <div class="similar-stuck" data-testid="similar-stuck">
    <button v-if="state === 'idle'" type="button" class="secondary small" @click="load">비슷한 막힘 보기</button>
    <p v-else-if="state === 'loading'" class="small muted" role="status">비슷한 막힘을 찾는 중…</p>
    <p v-else-if="state === 'error'" class="small muted">지금은 비슷한 막힘을 불러올 수 없습니다.</p>
    <template v-else-if="data">
      <p v-if="!data.indexed" class="small muted">이 막힘은 아직 의미 검색 색인에 들어가지 않았습니다. 잠시 뒤 다시 보세요.</p>
      <ul v-else-if="data.results.length" class="plain hub-list">
        <li v-for="r in data.results" :key="r.path" class="hub-card">
          <p class="small muted">
            <span class="badge">비슷한 막힘</span><template v-if="r.course"> · {{ r.course.schoolName }} · {{ r.course.title }}</template>
          </p>
          <p class="hub-card-title"><NuxtLink :to="r.path">{{ r.title }}</NuxtLink></p>
          <p v-if="r.snippet" class="small">{{ r.snippet }}</p>
        </li>
      </ul>
      <p v-else class="small muted">비슷한 공개 막힘을 찾지 못했습니다.</p>
    </template>
  </div>
</template>
