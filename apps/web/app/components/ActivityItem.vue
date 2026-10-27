<script setup lang="ts">
/**
 * 활동 카드 한 줄(S-05, ADR 0035): 프로필 글 본문 / 커뮤니티 글 제목·공간 / 선배 노트의 과목·학기 / 공개 사례·스터디 기록 제목·요약.
 * 서버가 읽을 때 원본을 다시 확인한 내용만 옵니다. 작성자 줄은 피드에서만 보입니다(`showAuthor`).
 * S-07(ADR 0036): 남의 프로필 글에는 신고 버튼(활동 id로 가리킴, 글 id는 공개되지 않음)을 둡니다(`reportable`). 피드에서 항목 링크를 열면
 * (`inFeed`) 분석 이벤트 `feed_item_opened`를 남깁니다 — 실패해도 이동을 막지 않습니다.
 */
import type { ActivityItemDto } from '~~/shared/types/api'
import type { ReportChoice } from '~/utils/moderation'

const props = defineProps<{ item: ActivityItemDto; showAuthor?: boolean; deletable?: boolean; busy?: boolean; reportable?: boolean; inFeed?: boolean }>()
defineEmits<{ delete: [] }>()

const SOURCE_LABELS: Record<ActivityItemDto['source'], string> = {
  profile_post: '프로필 글',
  community_post: '커뮤니티 글',
  senior_note: '선배 노트',
  publication_release: '공개 사례',
  study_release: '스터디 기록',
}
const label = computed(() => SOURCE_LABELS[props.item.source])
const heading = computed(() => (props.item.source === 'senior_note' ? `${props.item.title ?? '과목'} 선배 노트` : props.item.title))
const reportTargets = computed<ReportChoice[]>(() =>
  props.reportable && props.item.source === 'profile_post' && !props.item.profilePostId
    ? [{ id: 'post', label: `프로필 글 · @${props.item.author.handle}`, targetType: 'profile_post', targetRef: { activityId: props.item.id } }]
    : [],
)

function opened() {
  if (!props.inFeed) return
  $fetch('/api/v1/feed/opened', { method: 'POST', body: { activityId: props.item.id } }).catch(() => {})
}
</script>

<template>
  <article class="activity-item">
    <p class="small muted">
      <template v-if="showAuthor">
        <NuxtLink :to="`/u/${item.author.handle}`">{{ item.author.displayName }} @{{ item.author.handle }}</NuxtLink>
        <span v-if="item.author.kind === 'display'"> · 표시명 프로필</span> ·
      </template>
      <span class="badge">{{ label }}</span>
      <template v-if="item.context"> · {{ item.context }}</template>
      · <time :datetime="item.createdAt">{{ formatDateTime(item.createdAt) }}</time>
    </p>
    <p v-if="heading">
      <NuxtLink v-if="item.href" :to="item.href" @click="opened">{{ heading }}</NuxtLink>
      <strong v-else>{{ heading }}</strong>
    </p>
    <p v-if="item.body" class="activity-body">{{ item.body }}</p>
    <p v-if="deletable" class="small">
      <button type="button" class="link-button" :disabled="busy" @click="$emit('delete')">지우기</button>
    </p>
    <p v-else-if="reportTargets.length" class="small">
      <ReportButton :targets="reportTargets" :id-prefix="`post-${item.id}`" label="이 글 신고" />
    </p>
  </article>
</template>

<style scoped>
.activity-item {
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 0;
}
.activity-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
