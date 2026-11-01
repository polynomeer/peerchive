<script setup lang="ts">
/**
 * 홈의 "큐레이터 과목"(E-03, ADR 0048). 내가 지금 큐레이터인 과목이 있을 때만 보입니다(없으면 아무것도 그리지 않음).
 * 각 과목의 큐레이터 화면으로 가는 링크와, 공개 프로필 "후배 기여"에 이 과목을 보일지(본인 선택, 기본 꺼짐)를 고릅니다.
 */
import type { MyCuratedCourseDto } from '~~/shared/types/api'

const items = ref<MyCuratedCourseDto[]>([])
const failed = ref(false)
const busy = ref<string | null>(null)

async function load() {
  failed.value = false
  try {
    items.value = await $fetch<MyCuratedCourseDto[]>('/api/v1/me/curated-courses')
  } catch {
    failed.value = true
  }
}
onMounted(load)

async function toggle(item: MyCuratedCourseDto) {
  busy.value = item.course.id
  try {
    await $fetch(`/api/v1/me/curated-courses/${item.course.id}`, { method: 'PATCH', body: { showInPortfolio: !item.showInPortfolio } })
    await load()
  } catch {
    failed.value = true
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="items.length || failed" class="card" aria-labelledby="curator-courses-heading" data-testid="home-curator-courses">
    <h2 id="curator-courses-heading">큐레이터 과목</h2>
    <p v-if="failed" class="notice error" role="alert">큐레이터 과목을 불러오지 못했습니다.</p>
    <ul class="plain">
      <li v-for="item in items" :key="item.course.id">
        <p>
          <NuxtLink :to="`/curator/${item.course.id}`">{{ item.course.schoolName }} · {{ item.course.title }}</NuxtLink>
        </p>
        <label class="small">
          <input type="checkbox" :checked="item.showInPortfolio" :disabled="busy === item.course.id" @change="toggle(item)" />
          공개 프로필 "후배 기여"에 이 과목 큐레이터 활동 표시
        </label>
      </li>
    </ul>
  </section>
</template>
