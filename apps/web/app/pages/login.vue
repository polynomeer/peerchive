<script setup lang="ts">
useHead({ title: '로그인 — Peerchive' })

const route = useRoute()
const { me } = useAuth()
if (me.value) await navigateTo(me.value.profile ? '/projects' : '/onboarding')

const email = ref('')
const sending = ref(false)
const sent = ref(false)
const error = ref<string | null>(route.query.error === 'link' ? '로그인 링크가 만료되었거나 이미 사용되었습니다. 다시 요청하세요.' : null)
const fieldError = ref<string | undefined>()
// 하이드레이션 전에는 v-model이 아직 붙지 않아, 그때 입력한 주소가 하이드레이션 때 지워지고 빈 값으로 제출될 수 있습니다.
// 화면이 준비될 때까지 버튼을 막습니다.
const ready = ref(false)
onMounted(() => {
  ready.value = true
})

async function submit() {
  sending.value = true
  error.value = null
  fieldError.value = undefined
  try {
    await $fetch('/api/v1/auth/magic-link', { method: 'POST', body: { email: email.value } })
    sent.value = true
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) fieldError.value = fieldMessage(err.fields.email) ?? '이메일 주소를 확인하세요.'
    else if (err.status === 429) error.value = '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'
    else error.value = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div>
    <h1>로그인</h1>
    <p class="muted">비밀번호 없이 이메일로 받은 링크로 로그인합니다. 처음이면 계정이 만들어집니다.</p>

    <p v-if="error" class="notice error" role="alert">{{ error }}</p>

    <div v-if="sent" class="notice ok" role="status">
      <strong>메일을 확인하세요.</strong>
      <p>입력한 주소로 로그인 링크를 보냈습니다. 링크는 15분 동안 한 번만 쓸 수 있습니다. 메일이 오지 않으면 주소를 확인하고 다시 요청하세요.</p>
      <button type="button" class="secondary" @click="sent = false">다시 요청하기</button>
    </div>

    <form v-else class="stack" novalidate @submit.prevent="submit">
      <div class="field">
        <label for="email">이메일</label>
        <input
          id="email"
          v-model="email"
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          required
          :aria-invalid="fieldError ? 'true' : undefined"
          :aria-describedby="fieldError ? 'email-error' : undefined"
        />
        <p v-if="fieldError" id="email-error" class="field-error">{{ fieldError }}</p>
      </div>
      <div class="actions">
        <button type="submit" :disabled="sending || !ready">{{ sending ? '보내는 중…' : '로그인 링크 받기' }}</button>
      </div>
    </form>
  </div>
</template>
