<script setup lang="ts">
/**
 * 로그인 확인. 메일 링크의 토큰은 URL fragment(#token=)로 오며 서버로 전송되지 않습니다.
 * 페이지를 여는 것만으로는 토큰을 소비하지 않고, 사용자가 버튼을 눌러야 POST로 소비합니다
 * (메일 스캐너의 선열람 방지). 어느 계정으로 로그인하는지 가린 이메일을 보여 줍니다.
 */
useHead({ title: '로그인 확인 — Peerchive', meta: [{ name: 'referrer', content: 'no-referrer' }] })

const { refresh } = useAuth()
const state = ref<'checking' | 'ready' | 'verifying' | 'invalid' | 'error'>('checking')
const maskedEmail = ref('')
let token: string | null = null

onMounted(async () => {
  token = new URLSearchParams(window.location.hash.slice(1)).get('token')
  // 토큰을 주소창·방문 기록에 남기지 않습니다.
  history.replaceState(null, '', window.location.pathname)
  if (!token) {
    state.value = 'invalid'
    return
  }
  try {
    const res = await $fetch<{ maskedEmail: string }>('/api/v1/auth/magic-link/inspect', { method: 'POST', body: { token } })
    maskedEmail.value = res.maskedEmail
    state.value = 'ready'
  } catch (e) {
    state.value = apiError(e).status === 410 ? 'invalid' : 'error'
  }
})

async function confirm() {
  if (!token) return
  state.value = 'verifying'
  try {
    const res = await $fetch<{ next: string }>('/api/v1/auth/magic-link/verify', { method: 'POST', body: { token } })
    token = null
    await refresh()
    await navigateTo(res.next, { replace: true })
  } catch (e) {
    state.value = apiError(e).status === 410 ? 'invalid' : 'error'
  }
}
</script>

<template>
  <div>
    <h1>로그인 확인</h1>

    <p v-if="state === 'checking'" role="status">링크를 확인하는 중…</p>

    <template v-else-if="state === 'ready' || state === 'verifying'">
      <p><strong>{{ maskedEmail }}</strong> 계정으로 로그인합니다.</p>
      <p class="muted">직접 요청하지 않은 링크라면 누르지 말고 이 창을 닫으세요.</p>
      <div class="actions">
        <button type="button" :disabled="state === 'verifying'" @click="confirm">
          {{ state === 'verifying' ? '로그인하는 중…' : '로그인 계속하기' }}
        </button>
      </div>
    </template>

    <template v-else>
      <p class="notice error" role="alert">
        {{
          state === 'invalid'
            ? '로그인 링크가 만료되었거나 이미 사용되었습니다.'
            : '로그인하지 못했습니다. 잠시 후 다시 시도하세요.'
        }}
      </p>
      <NuxtLink to="/login">로그인 링크 다시 받기</NuxtLink>
    </template>
  </div>
</template>
