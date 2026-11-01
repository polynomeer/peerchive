<script setup lang="ts">
/**
 * 동문회·OB 방의 신분 배지(A-01, ADR 0038). 방 안의 글·댓글·방별 프로필 목록에서 이름 옆에 붙습니다.
 * 현역·OB·졸업생은 자기 신고, 기수는 자기 신고(방장·운영진이 고칠 수 있음). `졸업생 인증`은 학교를 연결한 방에서 그 학교 졸업생 인증이 있을 때만.
 */
import type { RoomProfileTagDto } from '~~/shared/types/api'

const props = defineProps<{ tag: RoomProfileTagDto | null | undefined }>()
const items = computed(() =>
  (props.tag?.badges ?? []).map((b) =>
    b === 'cohort' ? (props.tag?.cohortLabel ?? '') : b === 'alumni' && props.tag?.alumniVerified ? '졸업생 인증' : ROOM_BADGE_LABELS[b],
  ),
)
</script>

<template>
  <span v-if="items.length" class="room-badges" data-testid="room-badges">
    <span v-for="label in items" :key="label" class="badge">{{ label }}</span>
  </span>
</template>
