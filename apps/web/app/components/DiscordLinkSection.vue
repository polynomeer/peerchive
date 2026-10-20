<script setup lang="ts">
/**
 * 내 디스코드 계정 연결(T-09, ADR 0009). 연결 코드(10분·한 번만)를 만들어 디스코드에서 `/peerchive link 코드`로 연결하고,
 * 여기서 해제합니다. Peerchive는 디스코드 사용자 id만 저장하고 토큰·대화 내용은 받지 않습니다.
 */
import type { DiscordCodeDto, IntegrationsDto } from '~~/shared/types/api'

const state = ref<IntegrationsDto | null>(null)
const code = ref<DiscordCodeDto | null>(null)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function load() {
  try {
    state.value = await $fetch<IntegrationsDto>('/api/v1/me/integrations')
  } catch {
    notice.value = { kind: 'error', text: '연결 상태를 불러오지 못했습니다.' }
  }
}
onMounted(load)

async function createCode() {
  notice.value = null
  try {
    code.value = await $fetch<DiscordCodeDto>('/api/v1/me/integrations/discord/link-code', { method: 'POST' })
  } catch {
    notice.value = { kind: 'error', text: '연결 코드를 만들지 못했습니다.' }
  }
}

async function unlink() {
  if (!confirm('디스코드 연결을 해제할까요? 이미 남긴 로그는 그대로 있고, 이후 디스코드에서는 기록되지 않습니다.')) return
  try {
    await $fetch('/api/v1/me/integrations/discord', { method: 'DELETE' })
    code.value = null
    await load()
    notice.value = { kind: 'ok', text: '연결을 해제했습니다.' }
  } catch {
    notice.value = { kind: 'error', text: '해제하지 못했습니다.' }
  }
}
</script>

<template>
  <section id="discord" class="card" aria-labelledby="discord-link-heading">
    <h2 id="discord-link-heading">디스코드 연결</h2>
    <p class="hint">
      연결하면 과제에 연결된 디스코드 채널에서 <code>/log</code>와 📌로 빌드 로그를 남길 수 있습니다.
      Peerchive는 디스코드 사용자 번호만 저장하고, 토큰이나 다른 대화는 저장하지 않습니다.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <template v-if="state">
      <p v-if="state.discord.linked">
        연결됨 <span class="muted">(디스코드 사용자 {{ state.discord.externalIdHint }}, {{ new Date(state.discord.linkedAt!).toLocaleDateString('ko-KR') }})</span>
      </p>
      <p v-else class="muted">연결되지 않았습니다.</p>
      <div class="actions">
        <button type="button" @click="createCode">{{ state.discord.linked ? '다른 디스코드 계정으로 바꾸기' : '연결 코드 만들기' }}</button>
        <button v-if="state.discord.linked" type="button" class="danger" @click="unlink">연결 해제</button>
      </div>
      <div v-if="code" class="stack" style="margin-top: 1rem">
        <label for="link-code">디스코드에서 입력하세요 (한 번만 표시)</label>
        <div class="copy-box">
          <input id="link-code" :value="`/peerchive link ${code.code}`" readonly @focus="($event.target as HTMLInputElement).select()" />
        </div>
        <p class="hint">{{ new Date(code.expiresAt).toLocaleTimeString('ko-KR') }}까지, 한 번만 쓸 수 있습니다. 입력한 뒤 이 화면을 새로 고치면 연결 상태가 보입니다.</p>
      </div>
    </template>
  </section>
</template>
