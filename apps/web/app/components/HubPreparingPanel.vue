<script setup lang="ts">
/**
 * "준비 중" 과목 허브의 본인 안내(E-02, PROOFU_EVOLUTION_PLAN §8.6, ADR 0047). 공개 허브(SSR)는 로그인 상태를 읽지 않으므로 화면이 뜬 뒤
 * 로그인한 경우에만 `/api/v1/me/course-hubs/:id/opening`으로 내 상태를 묻습니다.
 * - 이 과목을 등록한 학생: "열리면 알려 주세요"(홈 알림, 취소 가능).
 * - 이 과목을 마친 학생: 선배 노트 요청(이미 쓴 노트가 있으면 내 노트 보기).
 * 신청 수나 다른 사람의 정보는 받지도 보여 주지도 않습니다.
 */
import type { MyHubOpeningDto } from '~~/shared/types/api'

const props = defineProps<{ courseId: string }>()
const state = ref<MyHubOpeningDto | null>(null)
const loggedIn = ref<boolean | null>(null)
const busy = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function load() {
  try {
    state.value = await $fetch<MyHubOpeningDto>(`/api/v1/me/course-hubs/${encodeURIComponent(props.courseId)}/opening`)
  } catch {
    state.value = null
  }
}

onMounted(async () => {
  const me = await useAuth().ensure()
  loggedIn.value = !!me
  if (me) await load()
})

async function toggleNotify() {
  if (!state.value) return
  busy.value = true
  message.value = null
  const requested = state.value.notifyRequested
  try {
    await $fetch(`/api/v1/me/course-hubs/${encodeURIComponent(props.courseId)}/notify`, { method: requested ? 'DELETE' : 'POST' })
    message.value = { kind: 'ok', text: requested ? '알림 신청을 취소했습니다.' : '열리면 홈에서 알려 드립니다.' }
    await load()
  } catch (e) {
    const code = apiError(e).code
    message.value = {
      kind: 'error',
      text: code === 'already_open' ? '이미 열렸습니다. 새로 고쳐 보세요.' : code === 'not_registered' ? '이 과목을 등록한 학생만 신청할 수 있습니다.' : '처리하지 못했습니다.',
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="loggedIn === false" class="small muted">
    <NuxtLink to="/login">로그인</NuxtLink>하면 이 과목이 열릴 때 알림을 받거나 선배 노트를 남길 수 있습니다.
  </div>
  <div v-else-if="state && state.status === 'preparing'" data-testid="hub-preparing-me">
    <p v-if="message" class="notice" :class="{ error: message.kind === 'error' }" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>
    <p v-if="state.registered">
      <button type="button" :class="state.notifyRequested ? 'secondary' : ''" :disabled="busy" @click="toggleNotify">
        {{ state.notifyRequested ? '알림 신청 취소' : '열리면 알려 주세요' }}
      </button>
      <span v-if="state.notifyRequested" class="small muted"> 신청했습니다. 열리면 홈에 알림이 뜹니다(나만 봄).</span>
    </p>
    <p v-else class="small muted">
      이 과목을 <NuxtLink to="/me/courses">등록</NuxtLink>하면 열릴 때 알림을 받을 수 있습니다.
    </p>
    <p v-if="state.finished" class="notice" data-testid="hub-note-request">
      이 과목을 마치셨네요. 후배를 위해 선배 노트를 남겨 주세요.
      <NuxtLink :to="`/senior-notes?course=${state.courseId}`">{{ state.wroteNote ? '내 선배 노트 보기' : '선배 노트 쓰기' }}</NuxtLink>
    </p>
  </div>
</template>
