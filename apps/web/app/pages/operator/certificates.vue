<script setup lang="ts">
/**
 * 수료증 확인(I-01, SYSTEM_DESIGN §6.7.2 CertificateCheck·§8.4, ADR 0037). 운영자만(아니면 404로 보임). P2 플래그 institutions가 꺼져 있으면 API가 404라 같은 화면입니다.
 * - 결정 전·검사 통과한 파일만 60초 서명 URL로 새 창에서 봅니다(보기 기록은 감사에 남음). 파일 이름은 저장하지 않습니다.
 * - 승인하면 그 기관 인증이 active, 거절하면 "수료증 확인에서 거절됨". 결정 시각이 남고(처리 시간 지표), 파일은 결정 뒤 10분 안에 worker가 지웁니다.
 */
import type { CertificateFileUrlDto, OperatorCertificateCheckDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '수료증 확인 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const view = ref<'pending' | 'decided'>('pending')
const { data: items, error, refresh } = await useFetch<OperatorCertificateCheckDto[]>('/api/v1/operator/certificate-checks', {
  query: computed(() => ({ status: view.value })),
})
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)

async function openFile(item: OperatorCertificateCheckDto) {
  busy.value = item.id
  notice.value = null
  try {
    const signed = await $fetch<CertificateFileUrlDto>(`/api/v1/operator/certificate-checks/${item.id}/file-url`, { method: 'POST' })
    window.open(signed.url, '_blank', 'noopener,noreferrer')
  } catch {
    notice.value = { kind: 'error', text: '파일을 열 수 없습니다(이미 결정했거나 검사 전일 수 있음).' }
    await refresh()
  } finally {
    busy.value = null
  }
}

async function decide(item: OperatorCertificateCheckDto, result: 'approved' | 'rejected') {
  const label = result === 'approved' ? '승인' : '거절'
  if (!window.confirm(`${item.user.displayName} · ${item.institution.name} 수료증을 ${label}할까요? 결정 뒤에는 파일을 다시 볼 수 없습니다.`)) return
  busy.value = item.id
  notice.value = null
  try {
    await $fetch(`/api/v1/operator/certificate-checks/${item.id}/decision`, { method: 'POST', body: { result } })
    notice.value = { kind: 'ok', text: `${label}했습니다. 파일은 곧 지워집니다.` }
    await refresh()
  } catch (e) {
    const code = apiError(e).code
    notice.value = { kind: 'error', text: code === 'already_decided' ? '이미 결정한 요청입니다.' : code === 'not_reviewable' ? '지금은 결정할 수 없는 요청입니다(취소·검사 전).' : '처리하지 못했습니다.' }
    await refresh()
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <h1>수료증 확인</h1>
      <p class="hint">
        이름·기관·기수가 계정과 맞는지만 확인하세요. 수료증 번호·내용을 옮겨 적지 않습니다. 파일은 결정 뒤 지우고 삭제 기록만 남깁니다.
      </p>
      <p class="actions">
        <button type="button" :class="view === 'pending' ? '' : 'secondary'" :aria-pressed="view === 'pending'" @click="view = 'pending'">대기</button>
        <button type="button" :class="view === 'decided' ? '' : 'secondary'" :aria-pressed="view === 'decided'" @click="view = 'decided'">결정함</button>
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <ul v-if="items?.length" class="plain hub-list">
        <li v-for="item in items" :key="item.id" class="hub-card">
          <p>
            <strong>{{ item.user.displayName }}</strong> · {{ item.institution.name }} ({{ INSTITUTION_KIND_LABELS[item.institution.kind] }})
            <template v-if="item.cohortLabel"> · {{ item.cohortLabel }}</template>
            · {{ standingLabelFor(item.institution.kind, item.standing) }}
          </p>
          <p class="small muted">
            {{ SCAN_STATUS_LABELS[item.scanStatus] }} · 요청 {{ seoulDay(item.createdAt) }}
            <template v-if="item.decidedAt"> · {{ item.result === 'approved' ? '승인' : '거절' }} {{ seoulDay(item.decidedAt) }}</template>
            <template v-if="item.filePurgedAt"> · 파일 삭제됨</template>
          </p>
          <p v-if="!item.decidedAt" class="actions">
            <button type="button" class="secondary" :disabled="!item.viewable || busy === item.id" @click="openFile(item)">파일 보기(60초)</button>
            <button type="button" :disabled="!item.viewable || busy === item.id" @click="decide(item, 'approved')">승인</button>
            <button type="button" class="danger" :disabled="!item.viewable || busy === item.id" @click="decide(item, 'rejected')">거절</button>
          </p>
        </li>
      </ul>
      <p v-else class="muted">{{ view === 'pending' ? '확인을 기다리는 수료증이 없습니다.' : '결정한 수료증이 없습니다.' }}</p>
    </template>
  </div>
</template>
