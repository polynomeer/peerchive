<script setup lang="ts">
/**
 * 활동 카드 한 줄(S-05, ADR 0035): 프로필 글 본문 / 커뮤니티 글 제목·공간 / 선배 노트의 과목·학기 / 공개 사례·스터디 기록 제목·요약.
 * 서버가 읽을 때 원본을 다시 확인한 내용만 옵니다. 작성자 줄은 피드에서만 보입니다(`showAuthor`).
 */
import type { ActivityItemDto } from '~~/shared/types/api'

const props = defineProps<{ item: ActivityItemDto; showAuthor?: boolean; deletable?: boolean; busy?: boolean }>()
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
      <NuxtLink v-if="item.href" :to="item.href">{{ heading }}</NuxtLink>
      <strong v-else>{{ heading }}</strong>
    </p>
    <p v-if="item.body" class="activity-body">{{ item.body }}</p>
    <p v-if="deletable" class="small">
      <button type="button" class="link-button" :disabled="busy" @click="$emit('delete')">지우기</button>
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
