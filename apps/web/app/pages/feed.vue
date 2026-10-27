<script setup lang="ts">
/**
 * 팔로우 피드와 팔로우 추천(S-05, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1·§8.3·§11.3, DELIVERY_PLAN §4.2 S-05, ADR 0035).
 * - 내가(실명·표시명 어느 프로필로든) 팔로우하는 프로필의 활동을 모읍니다. 이 화면은 나에게만 보입니다.
 * - 순서: 하루(한국 시간) 단위로 기록(공개 사례·선배 노트·스터디 기록)을 글보다 먼저, 그다음 최근 순. 인기·팔로워 수로 정렬하지 않습니다.
 * - 읽을 때마다 공개 범위·차단·뮤트·원본 상태를 다시 확인하므로 철회·숨김·차단·공개 범위 축소는 새로고침하면 바로 반영됩니다.
 * - 추천: 같은 과목·같은 학교(학교 배지를 공개한 실명 프로필만)·같은 관심 직무의 교집합만 이유와 함께 보여 줍니다.
 */
import { SUGGESTION_REASON_LABELS } from '@peerchive/domain'
import type { ActivityItemDto, FeedDto, FollowSuggestionsDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '피드 — Peerchive' })

const requestFetch = useRequestFetch()
const { data: feed, error } = await useAsyncData('feed', () => requestFetch<FeedDto>('/api/v1/feed'))
const { data: suggestions } = await useAsyncData('feed-suggestions', () => requestFetch<FollowSuggestionsDto>('/api/v1/feed/suggestions'))

const more = ref<ActivityItemDto[]>([])
const cursor = ref<string | null>(null)
watch(
  feed,
  (f) => {
    more.value = []
    cursor.value = f?.nextCursor ?? null
  },
  { immediate: true },
)
const reasonText = (reasons: ReadonlyArray<keyof typeof SUGGESTION_REASON_LABELS>) => reasons.map((r) => SUGGESTION_REASON_LABELS[r]).join(', ')
const items = computed(() => [...(feed.value?.items ?? []), ...more.value])
const loadingMore = ref(false)

async function loadMore() {
  if (!cursor.value) return
  loadingMore.value = true
  try {
    const res = await $fetch<FeedDto>('/api/v1/feed', { query: { cursor: cursor.value } })
    more.value = [...more.value, ...res.items]
    cursor.value = res.nextCursor
  } finally {
    loadingMore.value = false
  }
}
</script>

<template>
  <div class="stack">
    <h1>피드</h1>
    <p class="hint">
      팔로우하는 프로필의 공개 사례·선배 노트·스터디 기록·글입니다. 같은 날에는 기록을 먼저 보여 주며, 인기나 팔로워 수로 정렬하지 않습니다.
    </p>
    <p v-if="error" class="notice error" role="alert">피드를 불러오지 못했습니다. 새로고침해 보세요.</p>
    <template v-else-if="feed">
      <p v-if="!feed.following" class="muted">아직 팔로우하는 프로필이 없습니다. 아래 추천이나 공개 프로필에서 팔로우해 보세요.</p>
      <p v-else-if="!items.length" class="muted">새 활동이 없습니다.</p>
      <section v-if="items.length" aria-label="팔로우 피드">
        <ActivityItem v-for="item in items" :key="item.id" :item="item" show-author in-feed reportable />
        <p v-if="cursor"><button type="button" class="secondary" :disabled="loadingMore" @click="loadMore">더 보기</button></p>
      </section>
    </template>

    <section aria-labelledby="suggest-heading" class="stack">
      <h2 id="suggest-heading">팔로우 추천</h2>
      <p class="hint">같은 과목·같은 학교(학교 배지를 공개한 프로필)·같은 관심 직무가 겹치는 프로필만 보여 줍니다. 상대에게 알리지 않습니다.</p>
      <p v-if="!suggestions?.suggestions.length" class="muted small">
        추천할 프로필이 없습니다. <NuxtLink to="/onboarding">관심 직무</NuxtLink>나 <NuxtLink to="/settings/affiliations">학교 인증</NuxtLink>을 채우면 추천이 생길 수 있습니다.
      </p>
      <ul v-else class="plain">
        <li v-for="s in suggestions.suggestions" :key="s.handle">
          <NuxtLink :to="{ path: `/u/${s.handle}`, query: { from: 'suggestion' } }">{{ s.displayName }} @{{ s.handle }}</NuxtLink>
          <span v-if="s.kind === 'display'" class="muted small"> · 표시명 프로필</span>
          <span v-if="s.accountPrivacy === 'private'" class="muted small"> · 비공개 계정</span>
          <span class="small"> · {{ reasonText(s.reasons) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
