<script setup lang="ts">
/**
 * 홈의 과목 허브 알림(E-02, PROOFU_EVOLUTION_PLAN §8.6, ADR 0047). 단계적 개방 플래그가 켜져 있을 때만 불러옵니다.
 * - 알림을 신청한 과목 허브가 열렸으면 "열렸습니다"(닫기 가능). 서버가 이 목록을 읽을 때 열림을 판정해 한 번만 기록합니다.
 * - 마친 과목 중 아직 준비 중인 허브: 선배 노트 요청(닫기 가능, 노트를 쓰면 사라짐).
 * 본인 것만 봅니다. 알릴 것이 없으면 아무것도 그리지 않습니다.
 */
import type { MyHubNoticesDto } from '~~/shared/types/api'

const data = ref<MyHubNoticesDto | null>(null)
const busy = ref<string | null>(null)
const failed = ref(false)

async function load() {
  failed.value = false
  try {
    data.value = await $fetch<MyHubNoticesDto>('/api/v1/me/course-hub-notices')
  } catch {
    data.value = null
  }
}

onMounted(async () => {
  const flags = await useFeatures().ensure()
  if (flags.hubStagedOpening) await load()
})

async function run(key: string, url: string) {
  busy.value = key
  try {
    await $fetch(url, { method: 'POST' })
    await load()
  } catch {
    failed.value = true
  } finally {
    busy.value = null
  }
}

const name = (c: { title: string; code: string | null }) => `${c.title}${c.code ? ` (${c.code})` : ''}`
const empty = computed(() => !data.value || (data.value.opened.length === 0 && data.value.noteRequests.length === 0))
</script>

<template>
  <section v-if="!empty && data" class="card" aria-labelledby="hub-notices-heading" data-testid="home-hub-notices">
    <h2 id="hub-notices-heading">과목 허브 소식</h2>
    <p v-if="failed" class="notice error" role="alert">처리하지 못했습니다.</p>
    <ul v-if="data.opened.length" class="plain" aria-label="열린 과목 허브">
      <li v-for="n in data.opened" :key="n.id" class="notice">
        <p>
          <strong>{{ name(n.course) }}</strong> · {{ n.course.schoolName }} 과목 페이지가 열렸습니다.
          <NuxtLink :to="`/c/${n.course.id}`">과목 허브 보기</NuxtLink>
        </p>
        <p class="actions">
          <button type="button" class="link-button" :disabled="busy === n.id" @click="run(n.id, `/api/v1/me/course-hub-notices/${n.id}/dismiss`)">알림 닫기</button>
        </p>
      </li>
    </ul>
    <ul v-if="data.noteRequests.length" class="plain" aria-label="선배 노트 요청">
      <li v-for="r in data.noteRequests" :key="r.course.id" class="notice">
        <p>
          <strong>{{ name(r.course) }}</strong> · {{ r.course.schoolName }} 과목 페이지가 준비 중입니다({{ r.count }}/{{ r.threshold }}). 마친 과목이라면
          선배 노트를 남겨 주세요.
        </p>
        <p class="actions">
          <NuxtLink :to="`/senior-notes?course=${r.course.id}`">선배 노트 쓰기</NuxtLink>
          <button
            type="button"
            class="link-button"
            :disabled="busy === r.course.id"
            @click="run(r.course.id, `/api/v1/me/course-hubs/${r.course.id}/dismiss-note-request`)"
          >
            닫기
          </button>
        </p>
      </li>
    </ul>
  </section>
</template>
