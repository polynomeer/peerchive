<script setup lang="ts">
/**
 * 기관 인증 수단별 처리 큐(A-07, DELIVERY_PLAN §4.3 A-07·§6.2 기관 인증, ADR 0045). 운영자만(아니면 404로 보임). P2 플래그 institutions가 꺼져 있으면 API가 404라 같은 화면입니다.
 * - 초대 코드: 즉시 인증이라 대기 없음(최근 7일 사용 수, 5 미만 가림).
 * - 기수 승인: 같은 기수 멤버 2명이 승인하는 큐(운영자 처리 아님) — 나이·받은 승인 수·만료만. 요청한 사람·승인한 사람은 보이지 않습니다.
 * - 수료증 확인: 운영자 대기. 파일을 받은 시각부터 나이와 기한, 최근 30일 처리 시간(받은 시각 → 결정) 중앙값·p90(5건 미만 가림). 결정은 수료증 확인 화면에서.
 */
import type { VerificationQueueDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '인증 처리 큐 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data: queue, error, refresh } = await useFetch<VerificationQueueDto>('/api/v1/operator/institutions/verification-queue')
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const show = (v: number | null | undefined) => (v === null || v === undefined ? '가림(5 미만)' : String(v))
const SLA_LABELS: Record<string, string> = { ok: '기한 안', due_soon: '곧 기한', overdue: '기한 넘김' }
const SCAN_LABELS: Record<string, string> = { pending: '검사 대기', scanning: '검사 중', clean: '검사 통과', quarantined: '격리됨', failed: '검사 실패' }
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else-if="queue">
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink> · <NuxtLink to="/operator/certificates">수료증 확인</NuxtLink> · <NuxtLink to="/operator/metrics">지표</NuxtLink></p>
      <h1>기관 인증 처리 큐</h1>
      <p class="small muted">만든 시각 {{ formatDateTime(queue.generatedAt) }} <button type="button" class="small" @click="refresh()">새로 고침</button></p>

      <section aria-labelledby="vq-cert" data-testid="vq-certificate">
        <h2 id="vq-cert">수료증 확인(운영자 대기, 기한 {{ queue.certificateCheck.slaHours }}시간)</h2>
        <p data-testid="vq-certificate-recent">
          최근 30일 결정 {{ show(queue.certificateCheck.recent.decided) }}건 · 처리 시간 중앙값
          {{ queue.certificateCheck.recent.medianHours === null ? '가림(5건 미만)' : `${queue.certificateCheck.recent.medianHours}시간` }} · p90
          {{ queue.certificateCheck.recent.p90Hours === null ? '가림' : `${queue.certificateCheck.recent.p90Hours}시간` }} (목표 중앙값
          {{ queue.certificateCheck.recent.medianTargetHours }}시간)
        </p>
        <table v-if="queue.certificateCheck.pending.length" class="ledger-table">
          <thead><tr><th scope="col">기관 · 기수</th><th scope="col">받은 시각</th><th scope="col">나이</th><th scope="col">검사</th><th scope="col">기한</th></tr></thead>
          <tbody>
            <tr v-for="c in queue.certificateCheck.pending" :key="c.checkId">
              <th scope="row">{{ c.institutionName }}<template v-if="c.cohortLabel"> · {{ c.cohortLabel }}</template></th>
              <td>{{ c.receivedAt ? formatDateTime(c.receivedAt) : '-' }}</td>
              <td>{{ c.ageHours === null ? '-' : `${c.ageHours}시간` }}</td>
              <td>{{ SCAN_LABELS[c.scanStatus] ?? c.scanStatus }}</td>
              <td><span v-if="c.sla" class="badge">{{ SLA_LABELS[c.sla] }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">대기 중인 수료증이 없습니다.</p>
      </section>

      <section aria-labelledby="vq-cohort" data-testid="vq-cohort">
        <h2 id="vq-cohort">기수 승인(멤버 승인 대기 — 운영자 처리 아님)</h2>
        <table v-if="queue.cohortApproval.pending.length" class="ledger-table">
          <thead><tr><th scope="col">기관 · 기수</th><th scope="col">요청 시각</th><th scope="col">나이</th><th scope="col">승인</th><th scope="col">만료</th></tr></thead>
          <tbody>
            <tr v-for="c in queue.cohortApproval.pending" :key="c.affiliationId">
              <th scope="row">{{ c.institutionName }}<template v-if="c.cohortLabel"> · {{ c.cohortLabel }}</template></th>
              <td>{{ formatDateTime(c.requestedAt) }}</td>
              <td>{{ c.ageHours }}시간</td>
              <td>{{ c.approvals }}/{{ c.required }}</td>
              <td>{{ formatDateTime(c.expiresAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">승인을 기다리는 요청이 없습니다.</p>
        <p class="hint">승인이 모이지 않는 기관이 많으면 협력 기관에 초대 코드 발급을 안내합니다(RUNBOOK §4.6).</p>
      </section>

      <section aria-labelledby="vq-invite" data-testid="vq-invite">
        <h2 id="vq-invite">초대 코드(즉시 인증 — 대기 없음)</h2>
        <p>최근 7일 사용 {{ show(queue.inviteCode.redeemedLast7Days) }} · 지금 쓸 수 있는 코드 {{ queue.inviteCode.activeCodes }}개</p>
      </section>
    </template>
  </div>
</template>
