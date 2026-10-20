<script setup lang="ts">
/**
 * 과제의 디스코드 연결(T-09, ADR 0009). 멤버는 연결된 채널을 보고, owner는 채널 연결 코드를 만들고
 * 주간 요약 게시를 켜고 끄며 연결을 해제합니다. 채널은 디스코드 id로만 저장합니다.
 */
import type { DiscordBindingDto, DiscordCodeDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; isOwner: boolean }>()

const bindings = ref<DiscordBindingDto[]>([])
const loadError = ref(false)
const code = ref<DiscordCodeDto | null>(null)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function load() {
  try {
    bindings.value = await $fetch<DiscordBindingDto[]>(`/api/v1/projects/${props.projectId}/discord/bindings`)
    loadError.value = false
  } catch {
    loadError.value = true
  }
}
onMounted(load)

async function createCode() {
  notice.value = null
  try {
    code.value = await $fetch<DiscordCodeDto>(`/api/v1/projects/${props.projectId}/discord/bind-code`, { method: 'POST' })
  } catch {
    notice.value = { kind: 'error', text: '연결 코드를 만들지 못했습니다.' }
  }
}

async function toggleSummary(binding: DiscordBindingDto) {
  try {
    const updated = await $fetch<DiscordBindingDto>(`/api/v1/discord-bindings/${binding.id}`, {
      method: 'PATCH',
      body: { summaryEnabled: !binding.summaryEnabled },
    })
    bindings.value = bindings.value.map((b) => (b.id === updated.id ? updated : b))
    notice.value = { kind: 'ok', text: updated.summaryEnabled ? '주간 요약을 켰습니다.' : '주간 요약을 껐습니다.' }
  } catch {
    notice.value = { kind: 'error', text: '바꾸지 못했습니다.' }
    await load()
  }
}

async function unbind(binding: DiscordBindingDto) {
  if (!confirm('이 채널 연결을 해제할까요? 이미 남긴 로그는 그대로 있고, 승인 대기 중인 📌 요청은 사라집니다.')) return
  try {
    await $fetch(`/api/v1/discord-bindings/${binding.id}`, { method: 'DELETE' })
    await load()
    notice.value = { kind: 'ok', text: '연결을 해제했습니다.' }
  } catch {
    notice.value = { kind: 'error', text: '해제하지 못했습니다.' }
  }
}

const channelName = (b: DiscordBindingDto) => b.label || `채널 …${b.channelId.slice(-4)}`
</script>

<template>
  <section class="card" aria-labelledby="discord-heading">
    <h2 id="discord-heading">디스코드 연결</h2>
    <p class="hint">
      연결된 채널에서 <code>/log 태그 내용</code>이나 📌 반응으로 빌드 로그를 남길 수 있습니다(출처 “디스코드”).
      남의 메시지에 📌을 달면 작성자가 승인해야 저장됩니다. 먼저 각자
      <NuxtLink to="/onboarding#discord">프로필 설정</NuxtLink>에서 디스코드 계정을 연결하세요.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p v-if="loadError" class="notice error" role="alert">
      연결 목록을 불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <p v-else-if="bindings.length === 0" class="muted">연결된 채널이 없습니다.</p>
    <ul v-else class="plain">
      <li v-for="b in bindings" :key="b.id" class="row">
        <span>
          {{ channelName(b) }}
          <span class="muted"> · 주간 요약 {{ b.summaryEnabled ? '켜짐' : '꺼짐' }}</span>
        </span>
        <span v-if="isOwner" class="actions">
          <button type="button" class="secondary" @click="toggleSummary(b)">{{ b.summaryEnabled ? '주간 요약 끄기' : '주간 요약 켜기' }}</button>
          <button type="button" class="danger" @click="unbind(b)">연결 해제</button>
        </span>
      </li>
    </ul>
    <p v-if="isOwner" class="hint">
      주간 요약을 켜면 매주 화요일 10시에 지난주 팀원별 기록 요약(이름·종류별 개수·역할 선언)을 그 채널에 올립니다.
      채널에 팀원이 아닌 사람이 있다면 켜지 마세요. 체크인 알림은 일요일 20시에 올라갑니다.
    </p>

    <template v-if="isOwner">
      <h3>채널 연결하기</h3>
      <ol class="hint">
        <li>프로필 설정에서 내 디스코드 계정을 연결합니다.</li>
        <li>아래에서 코드를 만들고(10분 동안 한 번만), 기록할 디스코드 채널에서 <code>/peerchive bind 코드</code>를 입력합니다.</li>
      </ol>
      <div class="actions">
        <button type="button" @click="createCode">채널 연결 코드 만들기</button>
      </div>
      <div v-if="code" class="stack" style="margin-top: 1rem">
        <label for="bind-code">채널 연결 코드 (한 번만 표시)</label>
        <div class="copy-box">
          <input id="bind-code" :value="`/peerchive bind ${code.code}`" readonly @focus="($event.target as HTMLInputElement).select()" />
        </div>
        <p class="hint">{{ new Date(code.expiresAt).toLocaleTimeString('ko-KR') }}까지 쓸 수 있습니다.</p>
      </div>
    </template>
  </section>
</template>
