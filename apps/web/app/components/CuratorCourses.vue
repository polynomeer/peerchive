<script setup lang="ts">
/**
 * 홈의 "큐레이터 과목"(E-03, ADR 0048). 내가 지금 큐레이터인 과목이 있을 때만 보입니다(없으면 아무것도 그리지 않음).
 * 각 과목의 큐레이터 화면으로 가는 링크와, 공개 프로필 "후배 기여"에 이 과목을 보일지(본인 선택, 기본 꺼짐)를 고릅니다.
 */
import type { CuratorProposalDto, MyCuratedCourseDto } from '~~/shared/types/api'

const items = ref<MyCuratedCourseDto[]>([])
const proposals = ref<CuratorProposalDto[]>([])
const failed = ref(false)
const busy = ref<string | null>(null)

async function load() {
  failed.value = false
  try {
    ;[items.value, proposals.value] = await Promise.all([$fetch<MyCuratedCourseDto[]>('/api/v1/me/curated-courses'), $fetch<CuratorProposalDto[]>('/api/v1/me/curator-proposals')])
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

// 운영자의 지정은 제안입니다. 수락해야 권한이 생깁니다(ADR 0060 D-08).
const answerError = ref<string | null>(null)
async function answer(p: CuratorProposalDto, action: 'accept' | 'decline') {
  busy.value = p.id
  answerError.value = null
  try {
    await $fetch(`/api/v1/me/curator-proposals/${p.id}/${action}`, { method: 'POST' })
    await load()
  } catch {
    answerError.value = '지금은 수락할 수 없습니다. 그 과목을 마쳤고 학교 인증이 유효한지 확인하세요.'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="items.length || proposals.length || failed" class="card" aria-labelledby="curator-courses-heading" data-testid="home-curator-courses">
    <h2 id="curator-courses-heading">큐레이터 과목</h2>
    <p v-if="failed" class="notice error" role="alert">큐레이터 과목을 불러오지 못했습니다.</p>
    <p v-if="answerError" class="notice error" role="alert">{{ answerError }}</p>
    <ul v-if="proposals.length" class="plain" data-testid="curator-proposals">
      <li v-for="p in proposals" :key="p.id">
        <p>운영자가 <strong>{{ p.course.schoolName }} · {{ p.course.title }}</strong> 큐레이터를 제안했습니다. 과제 유형 요약, 개념 태그 병합 제안, 신고 1차 의견을 맡습니다. 수락해야 시작됩니다.</p>
        <p class="actions">
          <button type="button" :disabled="busy === p.id" @click="answer(p, 'accept')">수락</button>
          <button type="button" class="secondary" :disabled="busy === p.id" @click="answer(p, 'decline')">거절</button>
        </p>
      </li>
    </ul>
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
