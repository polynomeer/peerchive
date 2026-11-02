<script setup lang="ts">
/**
 * 내 GitHub 계정 연결(E-11, ADR 0056). GitHub App의 사용자 인증으로 GitHub 사용자 번호와 로그인 이름만 확인해 저장합니다(토큰·메일 저장 없음).
 * 연결하면 연결된 과제 저장소의 내 커밋·PR이 역할 선언의 근거 후보로 보입니다(자동 확정 없음). GitHub App 설정이 없으면 이 칸이 보이지 않습니다.
 */
import type { GithubIdentityDto, GithubRedirectDto } from '~~/shared/types/api'

const route = useRoute()
const state = ref<GithubIdentityDto | null>(null)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(githubResultNotice(route.query.github))
const busy = ref(false)

async function load() {
  try {
    state.value = await $fetch<GithubIdentityDto>('/api/v1/me/integrations/github')
  } catch {
    notice.value = { kind: 'error', text: 'GitHub 연결 상태를 불러오지 못했습니다.' }
  }
}
onMounted(load)

async function link() {
  busy.value = true
  notice.value = null
  try {
    const { url } = await $fetch<GithubRedirectDto>('/api/v1/me/integrations/github/link', { method: 'POST' })
    window.location.assign(url)
  } catch {
    busy.value = false
    notice.value = { kind: 'error', text: 'GitHub 연결을 시작하지 못했습니다.' }
  }
}

async function unlink() {
  if (!confirm('GitHub 연결을 해제할까요? 이미 선언 근거로 고른 커밋·PR은 그대로 남고, 이후에는 내 커밋·PR이 근거 후보로 보이지 않습니다.')) return
  try {
    await $fetch('/api/v1/me/integrations/github', { method: 'DELETE' })
    await load()
    notice.value = { kind: 'ok', text: 'GitHub 연결을 해제했습니다. GitHub 설정(Applications)에서 앱 권한도 철회할 수 있습니다.' }
  } catch {
    notice.value = { kind: 'error', text: '해제하지 못했습니다.' }
  }
}
</script>

<template>
  <section id="github" class="card" aria-labelledby="github-link-heading" data-testid="github-link-section">
    <h2 id="github-link-heading">GitHub 연결</h2>
    <p class="hint">
      연결하면 과제에 연결된 저장소의 내 커밋·PR이 역할 선언의 <strong>근거 후보</strong>로 보입니다. 자동으로 확정되거나 집계되지 않습니다.
      Peerchive는 GitHub 사용자 번호와 로그인 이름만 저장하고 토큰·메일 주소는 저장하지 않습니다.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <template v-if="state">
      <p v-if="state.linked">
        연결됨 <span class="muted">(@{{ state.login }}, {{ new Date(state.linkedAt!).toLocaleDateString('ko-KR') }})</span>
      </p>
      <p v-else class="muted">연결되지 않았습니다.</p>
      <div class="actions">
        <button type="button" :disabled="busy" @click="link">{{ state.linked ? '다른 GitHub 계정으로 바꾸기' : 'GitHub 계정 연결' }}</button>
        <button v-if="state.linked" type="button" class="danger" @click="unlink">연결 해제</button>
      </div>
    </template>
  </section>
</template>
