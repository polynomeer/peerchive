<script setup lang="ts">
/**
 * 학교를 넘나드는 토픽 목록(A-05, PROOFU_EVOLUTION_PLAN §8.9.10, ADR 0042). 로그인 전용·noindex·제목 고정(C-05). P2 topics 플래그가 꺼지면 404.
 * - 토픽은 운영자가 엽니다. 학교·기관 인증이 하나라도 있으면 누구나 읽고 씁니다(가입 없음).
 * - 토픽 글에는 이름 대신 소속과 신분(`○○대 · 졸업생`)만 보이고, 인증 회원이 적은 소속은 넓은 범주로 바뀝니다. 멤버 수·글 수는 보여 주지 않습니다.
 */
import type { TopicCategory, TopicListDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const CATEGORY_LABELS: Record<TopicCategory, string> = {
  career: '취준',
  grad_school: '대학원',
  startup: '창업',
  military: '군대·예비역',
  campus_life: '학교생활',
  role: '직무',
}

const fetcher = useRequestFetch()
const { data, error } = await useAsyncData('community-topics', () => fetcher<TopicListDto>('/api/v1/community/topics'))
const missing = computed(() => !!error.value || !data.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
</script>

<template>
  <div class="community-page topics-page">
    <template v-if="missing">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="data">
      <h1>토픽</h1>
      <p class="hint">
        학교를 넘나드는 이야기 공간입니다. 글에는 이름 대신 소속과 신분(예: ○○대 · 졸업생)만 보이고, 학과·기수·입학연도는 보이지 않습니다.
        인증 회원이 적은 소속은 익명을 지키려고 학교·기관 유형(예: 부트캠프 수료생)으로 넓혀 표시합니다.
      </p>
      <p v-if="!data.eligible" class="notice" data-testid="topics-need-affiliation">
        토픽은 학교·기관 인증을 한 계정만 씁니다.
        <NuxtLink to="/settings/affiliations?return=/community/topics">인증하러 가기</NuxtLink>
      </p>
      <ul v-else-if="data.items.length" class="plain hub-list" data-testid="topic-list">
        <li v-for="t in data.items" :key="t.slug" class="hub-card">
          <p>
            <NuxtLink :to="`/community/s/${t.slug}`"><strong>{{ t.name }}</strong></NuxtLink>
            <span class="badge">{{ CATEGORY_LABELS[t.category] }}</span>
            <span v-if="t.status !== 'active'" class="muted"> · {{ SPACE_STATUS_LABELS[t.status] }}</span>
          </p>
          <p v-if="t.description" class="small muted">{{ t.description }}</p>
        </li>
      </ul>
      <p v-else class="muted">아직 열린 토픽이 없습니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>
