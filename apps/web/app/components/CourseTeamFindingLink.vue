<script setup lang="ts">
/**
 * 과목 허브의 "이 과목 팀원 찾기" 링크(C-07, ADR 0024). 공개 과목 허브(SSR)는 로그인 상태·커뮤니티 데이터를 읽지 않으므로, 화면이 뜬 뒤
 * 클라이언트에서 로그인한 경우에만 커뮤니티 API에 그 과목 학교 인증 여부·팀원 찾기 꺼짐을 묻습니다. 아니면(비로그인·다른 학교·미인증·꺼짐)
 * 아무것도 그리지 않습니다. 모집 글·수는 공개 화면에 싣지 않습니다.
 */
import type { CourseTeamFindingEntryDto } from '~~/shared/types/api'

const props = defineProps<{ courseId: string }>()
const available = ref(false)

onMounted(async () => {
  const me = await useAuth().ensure()
  if (!me) return
  try {
    const res = await $fetch<CourseTeamFindingEntryDto>('/api/v1/community/recruitments/course-entry', { query: { courseId: props.courseId } })
    available.value = res.available
  } catch {
    available.value = false
  }
})
</script>

<template>
  <p v-if="available" class="small" data-testid="course-team-finding">
    <NuxtLink :to="`/community/recruitments?course=${courseId}`">이 과목 팀원 찾기·스터디 모집</NuxtLink>
    <span class="muted"> (같은 학교 인증 사용자만 보는 커뮤니티)</span>
  </p>
</template>
