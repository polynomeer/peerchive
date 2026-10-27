<script setup lang="ts">
/**
 * 커뮤니티 방 초대 수락(C-02, ADR 0019). 로그인 전용·noindex. 토큰은 서버 렌더링에 쓰지 않고 브라우저에서 읽어 POST 본문으로만 보냅니다
 * (URL의 토큰이 서버 로그·Referer에 남지 않게, no-referrer). 초대는 7일 동안 한 번만 쓸 수 있습니다.
 */
import type { JoinResultDto, SpaceInvitationPreviewDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '방 초대 — Peerchive', meta: [{ name: 'robots', content: 'noindex, nofollow' }, { name: 'referrer', content: 'no-referrer' }] })
if (import.meta.server) useResponseHeader('x-robots-tag').value = 'noindex, nofollow'

const preview = ref<SpaceInvitationPreviewDto | null>(null)
const state = ref<'loading' | 'ready' | 'accepting' | 'gone' | 'error'>('loading')
const message = ref('')
let token: string | null = null

onMounted(async () => {
  const value = useRoute().params.token
  token = typeof value === 'string' ? value : null
  if (!token) {
    state.value = 'gone'
    return
  }
  try {
    preview.value = await $fetch<SpaceInvitationPreviewDto>('/api/v1/community/invitations/preview', { method: 'POST', body: { token } })
    state.value = 'ready'
  } catch (e) {
    state.value = apiError(e).status === 410 ? 'gone' : 'error'
  }
})

async function accept() {
  if (!token) return
  state.value = 'accepting'
  try {
    const res = await $fetch<JoinResultDto>('/api/v1/community/invitations/accept', { method: 'POST', body: { token } })
    await navigateTo(`/community/s/${res.space.slug}`, { replace: true })
  } catch (e) {
    const err = apiError(e)
    if (err.status === 410) state.value = 'gone'
    else {
      state.value = 'ready'
      message.value = err.status === 404 ? '이 방은 연결된 학교 메일로 인증한 계정만 들어갈 수 있습니다.' : communityErrorMessage(err.code)
    }
  }
}

const REASONS: Record<SpaceInvitationPreviewDto['reason'], string> = {
  ok: '',
  already_member: '이미 이 방의 멤버입니다.',
  not_eligible: '이 방은 연결된 학교 메일로 인증한 계정만 들어갈 수 있습니다. 학교 인증을 먼저 하세요.',
  full: '정원이 찼습니다.',
}
</script>

<template>
  <div>
    <h1>방 초대</h1>
    <p v-if="state === 'loading'" role="status">초대를 확인하는 중입니다.</p>
    <p v-else-if="state === 'gone'" class="notice error" role="alert">
      초대 링크를 사용할 수 없습니다. 만료되었거나, 이미 사용되었거나, 취소된 링크입니다. 초대한 사람에게 새 링크를 요청하세요.
    </p>
    <p v-else-if="state === 'error'" class="notice error" role="alert">초대를 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.</p>
    <template v-else-if="preview">
      <h2>{{ preview.space.name }}</h2>
      <p class="small muted">
        {{ SPACE_KIND_LABELS[preview.space.kind] }} · {{ preview.space.school?.name ?? '학교 무관' }} · 이름 표시: {{ NAME_MODE_LABELS[preview.space.nameMode] }}
      </p>
      <p v-if="preview.space.description" class="pre">{{ preview.space.description }}</p>
      <p class="small muted">이 링크는 {{ formatDateTime(preview.expiresAt) }}까지 한 번만 쓸 수 있습니다.</p>
      <p v-if="message" class="notice error" role="alert">{{ message }}</p>
      <p v-if="!preview.acceptable" class="notice" role="status">
        {{ REASONS[preview.reason] }}
        <NuxtLink v-if="preview.reason === 'already_member'" :to="`/community/s/${preview.space.slug}`">방으로 가기</NuxtLink>
        <NuxtLink v-else-if="preview.reason === 'not_eligible'" to="/settings/affiliations">학교 인증하러 가기</NuxtLink>
      </p>
      <p v-else class="actions"><button type="button" :disabled="state === 'accepting'" @click="accept">초대 수락</button></p>
    </template>
  </div>
</template>
