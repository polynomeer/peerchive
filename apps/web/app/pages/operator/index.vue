<script setup lang="ts">
/**
 * 운영자 신고 대기열(T-15, ADR 0015). 운영자가 아니면 404로 보입니다(존재를 드러내지 않음, API는 403 operator_only).
 * 대상별로 묶은 신고(개수·사유·처음/마지막 신고·담당자·보류)와 열린 이의제기. 목표 대응 시간은 apps/README.md "운영"을 보세요.
 * 신고 누적으로 임시 숨김된 커뮤니티 글·댓글(C-06)은 맨 앞에 "임시 숨김 · 우선 검토"로 보입니다. 신고와 이어지지 않은 이의제기(방 운영진 가리기·
 * 이용 제한)는 여기서 바로 결정합니다.
 */
import type { OperatorAppealDto, OperatorReportGroupDto, ReportStatus } from '~~/shared/types/api'

const decisions = reactive<Record<string, { decision: 'uphold' | 'reverse'; note: string }>>({})
const decideFor = (id: string) => (decisions[id] ??= { decision: 'uphold', note: '' })
const appealMessage = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
async function decideAppeal(id: string) {
  appealMessage.value = null
  try {
    await $fetch(`/api/v1/operator/appeals/${id}/decide`, { method: 'POST', body: { ...decideFor(id) } })
    appealMessage.value = { kind: 'ok', text: '이의제기를 결정했습니다.' }
    await refreshAppeals()
  } catch (e) {
    const err = apiError(e)
    appealMessage.value = { kind: 'error', text: err.code === 'validation_failed' ? '결정 메모를 적어 주세요.' : moderationErrorMessage(err.code) }
  }
}

definePageMeta({ middleware: 'auth' })
useHead({ title: '운영 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const STATUSES: Array<{ value: ReportStatus; label: string }> = [
  { value: 'open', label: '접수' },
  { value: 'in_review', label: '검토 중' },
  { value: 'resolved', label: '처리됨' },
  { value: 'dismissed', label: '기각' },
]
const route = useRoute()
const status = computed<ReportStatus>(() => (STATUSES.some((s) => s.value === route.query.status) ? (route.query.status as ReportStatus) : 'open'))

const { data: groups, error } = await useFetch<OperatorReportGroupDto[]>('/api/v1/operator/reports', { query: { status } })
const { data: appeals, refresh: refreshAppeals } = await useFetch<OperatorAppealDto[]>('/api/v1/operator/appeals', { query: { status: 'open' } })

const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const reasonsText = (g: OperatorReportGroupDto) =>
  Object.entries(g.reasons)
    .map(([r, n]) => `${REPORT_REASON_LABELS[r as keyof typeof REPORT_REASON_LABELS]} ${n}`)
    .join(' · ')
const age = (iso: string) => {
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  return hours < 1 ? '1시간 이내' : hours < 48 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <h1>신고 대기열</h1>
      <p><NuxtLink to="/operator/metrics">pilot 지표·시스템 상태 보기</NuxtLink> · <NuxtLink to="/operator/community">커뮤니티 운영(공식 페이지·공간)</NuxtLink> · <NuxtLink to="/operator/community-moderation">커뮤니티 제재(요청·작성자 확인·이용 제한)</NuxtLink></p>
      <p class="hint">
        운영자는 공개됐던 내용만 봅니다(비공개 과제 공간은 볼 수 없음). 모든 처리·배정·이의 결정은 감사 기록에 남습니다. 삭제는 이 화면에서 하지 않습니다.
      </p>
      <nav aria-label="신고 상태">
        <ul class="nav-list">
          <li v-for="s in STATUSES" :key="s.value">
            <NuxtLink :to="{ query: { status: s.value } }" :aria-current="status === s.value ? 'page' : undefined">{{ s.label }}</NuxtLink>
          </li>
        </ul>
      </nav>
      <ul v-if="groups?.length" class="plain operator-list">
        <li v-for="g in groups" :key="g.reportId">
          <p>
            <NuxtLink :to="`/operator/reports/${g.reportId}`"><strong>{{ g.targetLabel || REPORT_TARGET_LABELS[g.targetType] }}</strong></NuxtLink>
            <span v-if="g.hold" class="badge embargo">게시 보류 중</span>
            <span v-if="g.autoHidden" class="badge embargo" data-testid="auto-hidden-badge">임시 숨김 · 우선 검토</span>
          </p>
          <p class="small">신고 {{ g.count }}건 · {{ reasonsText(g) }}</p>
          <p class="small muted">
            처음 {{ formatDateTime(g.firstReportedAt) }}({{ age(g.firstReportedAt) }}) · 마지막 {{ formatDateTime(g.lastReportedAt) }}
            · 담당: {{ g.assignee?.displayName || '없음' }}
          </p>
        </li>
      </ul>
      <p v-else class="muted">이 상태의 신고가 없습니다.</p>

      <h2>열린 이의제기</h2>
      <p v-if="appealMessage" :class="['notice', appealMessage.kind]" :role="appealMessage.kind === 'error' ? 'alert' : 'status'">{{ appealMessage.text }}</p>
      <ul v-if="appeals?.length" class="plain operator-list">
        <li v-for="a in appeals" :key="a.id">
          <p>
            <strong>{{ a.action.targetLabel }}</strong> · {{ ACTION_LABELS[a.action.kind] }}
            <NuxtLink v-if="a.reportId" :to="`/operator/reports/${a.reportId}`">신고 보기·결정</NuxtLink>
          </p>
          <p class="small pre">“{{ a.message }}”</p>
          <p class="small muted">이의 {{ formatDateTime(a.createdAt) }} · 조치 {{ formatDateTime(a.action.createdAt) }}</p>
          <template v-if="!a.reportId">
            <p class="small">당사자 사유: {{ a.action.publicReason }} · 내부 메모: {{ a.action.internalNote }}</p>
            <form class="stack" @submit.prevent="decideAppeal(a.id)">
              <fieldset>
                <legend>결정</legend>
                <label><input v-model="decideFor(a.id).decision" type="radio" value="uphold" :name="`ad-${a.id}`" /> 조치 유지</label>
                <label><input v-model="decideFor(a.id).decision" type="radio" value="reverse" :name="`ad-${a.id}`" /> 되돌리기(조치 풀기)</label>
              </fieldset>
              <div class="field">
                <label :for="`ad-note-${a.id}`">결정 메모(필수)</label>
                <textarea :id="`ad-note-${a.id}`" v-model="decideFor(a.id).note" rows="2" maxlength="1000" required />
              </div>
              <p class="actions"><button type="submit">결정하기</button></p>
            </form>
          </template>
        </li>
      </ul>
      <p v-else class="muted">열린 이의제기가 없습니다.</p>
    </template>
  </div>
</template>
