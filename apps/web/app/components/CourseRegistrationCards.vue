<script setup lang="ts">
/**
 * 홈의 "이번 학기 과목"(E-01, PROOFU_EVOLUTION_PLAN §8.7). 등록한 과목마다 과목 허브·선배 노트·플랜 포크·과제 공간 만들기 진입점을 보여 주고,
 * 학기가 끝난 과목에는 worker가 만든 알림("선배 노트를 남겨 주세요"·"공개할까요?")을 보여 줍니다(닫기 가능).
 * 등록 정보는 본인만 봅니다. 로그인한 사람의 홈에서만 클라이언트가 불러옵니다.
 */
import type { CourseRegistrationDto, MyCourseRegistrationsDto } from '~~/shared/types/api'

const data = ref<MyCourseRegistrationsDto | null>(null)
const failed = ref(false)
const busy = ref<string | null>(null)

async function load() {
  failed.value = false
  try {
    data.value = await $fetch<MyCourseRegistrationsDto>('/api/v1/me/course-registrations')
  } catch {
    failed.value = true
  }
}
onMounted(load)

/** 홈에는 아직 끝나지 않은 학기의 과목과, 닫지 않은 학기 종료 알림만 보여 줍니다(나머지는 과목 관리 화면). */
const active = computed(() => data.value?.items.filter((r) => r.phase !== 'ended') ?? [])
const prompts = computed(() => data.value?.items.filter((r) => r.postTermPrompt) ?? [])

async function dismiss(r: CourseRegistrationDto) {
  busy.value = r.id
  try {
    await $fetch(`/api/v1/me/course-registrations/${r.id}/dismiss-prompt`, { method: 'POST' })
    await load()
  } catch {
    failed.value = true
  } finally {
    busy.value = null
  }
}

const courseName = (r: CourseRegistrationDto) => `${r.course.title}${r.course.code ? ` (${r.course.code})` : ''}`
</script>

<template>
  <section class="card" aria-labelledby="my-courses-heading" data-testid="home-course-registrations">
    <h2 id="my-courses-heading">이번 학기 과목</h2>
    <p class="hint">등록한 과목은 나만 봅니다. 공개 프로필·검색에는 나오지 않습니다.</p>
    <p v-if="failed" class="notice error" role="alert">과목 목록을 불러오지 못했습니다.</p>

    <ul v-if="prompts.length" class="plain" aria-label="학기가 끝난 과목 알림">
      <li v-for="r in prompts" :key="`prompt-${r.id}`" class="notice">
        <p>
          <strong>{{ courseName(r) }}</strong> · {{ r.termLabel }} 학기가 끝났습니다. 후배를 위해 선배 노트를 남겨 주세요.
          <template v-if="r.myProjects.length">이 과목 과제를 공개할까요? 공개는 팀 모두의 동의를 거칩니다.</template>
        </p>
        <p class="actions">
          <NuxtLink :to="`/senior-notes?course=${r.course.id}`">선배 노트 쓰기</NuxtLink>
          <NuxtLink v-for="p in r.myProjects" :key="p.id" :to="`/projects/${p.id}/publish`">‘{{ p.title }}’ 공개 준비</NuxtLink>
          <button type="button" class="link-button" :disabled="busy === r.id" @click="dismiss(r)">알림 닫기</button>
        </p>
      </li>
    </ul>

    <p v-if="data && active.length === 0" class="muted">아직 등록한 과목이 없습니다.</p>
    <ul v-else-if="active.length" class="plain" aria-label="등록한 과목">
      <li v-for="r in active" :key="r.id" class="course-entry">
        <p>
          <strong>{{ courseName(r) }}</strong>
          <span class="muted"> · {{ r.school.name }} · {{ r.termLabel }}</span>
          <span v-if="r.phase === 'upcoming'" class="badge">이후 학기</span>
        </p>
        <p class="actions" :aria-label="`${r.course.title} 바로 가기`">
          <NuxtLink :to="`/c/${r.course.id}`">과목 허브</NuxtLink>
          <NuxtLink :to="`/c/${r.course.id}#hub-notes`">선배 노트</NuxtLink>
          <NuxtLink :to="`/c/${r.course.id}#hub-cases`">플랜 포크</NuxtLink>
          <NuxtLink :to="`/projects?registration=${r.id}`">이 과목으로 과제 공간 만들기</NuxtLink>
        </p>
      </li>
    </ul>
    <p><NuxtLink to="/me/courses">과목 등록·관리</NuxtLink></p>
  </section>
</template>

<style scoped>
.course-entry + .course-entry {
  margin-top: 0.75rem;
}
</style>
