<script setup lang="ts">
/**
 * 초대 수락. 토큰은 서버 렌더링에 쓰지 않고, 브라우저에서 읽어 POST 본문으로만 보냅니다.
 * 이 페이지에서 나가는 링크의 Referer에 토큰이 실리지 않도록 no-referrer를 둡니다.
 */
useHead({ title: '초대 — Peerchive', meta: [{ name: 'referrer', content: 'no-referrer' }] })

const { me } = useAuth()
const state = ref<'idle' | 'accepting' | 'done' | 'gone' | 'already' | 'error'>('idle')
let token: string | null = null

onMounted(() => {
  const value = useRoute().params.token
  token = typeof value === 'string' ? value : null
  if (!token) state.value = 'gone'
  // 로그인·온보딩을 거친 뒤 이어서 수락하도록 이 브라우저에 잠시 보관합니다.
  else if (!me.value?.profile) savePendingInvite(token)
})

async function accept() {
  if (!token) return
  state.value = 'accepting'
  try {
    const res = await $fetch<{ projectId: string }>('/api/v1/invitations/accept', { method: 'POST', body: { token } })
    state.value = 'done'
    await navigateTo(`/projects/${res.projectId}`, { replace: true })
  } catch (e) {
    const err = apiError(e)
    state.value = err.status === 410 ? 'gone' : err.status === 409 ? 'already' : 'error'
  }
}
</script>

<template>
  <div>
    <h1>과제 초대</h1>

    <template v-if="!me">
      <p>초대를 수락하려면 먼저 로그인하세요. 로그인한 뒤 이 브라우저에서 초대가 이어집니다.</p>
      <NuxtLink to="/login">로그인하기</NuxtLink>
    </template>

    <template v-else-if="!me.profile">
      <p>초대를 수락하기 전에 프로필을 만들어 주세요. 저장하면 초대로 돌아옵니다.</p>
      <NuxtLink to="/onboarding">프로필 만들기</NuxtLink>
    </template>

    <template v-else>
      <p v-if="state === 'gone'" class="notice error" role="alert">
        초대 링크를 사용할 수 없습니다. 만료되었거나, 이미 사용되었거나, 취소된 링크입니다. 초대한 사람에게 새 링크를 요청하세요.
      </p>
      <p v-else-if="state === 'already'" class="notice" role="status">
        이미 이 과제의 멤버입니다. <NuxtLink to="/projects">내 과제</NuxtLink>에서 확인하세요.
      </p>
      <p v-else-if="state === 'error'" class="notice error" role="alert">초대를 수락하지 못했습니다. 다시 시도하세요.</p>

      <template v-if="state === 'idle' || state === 'accepting' || state === 'error'">
        <p>비공개 과제 공간에 초대받았습니다. 수락하면 팀 멤버만 볼 수 있는 기록에 참여합니다.</p>
        <button type="button" :disabled="state === 'accepting'" @click="accept">
          {{ state === 'accepting' ? '수락하는 중…' : '초대 수락' }}
        </button>
      </template>
    </template>
  </div>
</template>
