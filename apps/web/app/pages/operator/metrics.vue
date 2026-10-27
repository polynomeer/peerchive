<script setup lang="ts">
/**
 * 운영자 pilot 지표·시스템 상태(T-16, ADR 0016). 운영자가 아니면 404로 보입니다(API는 403 operator_only).
 * 지표는 분석 이벤트만으로 계산하고 5 미만은 "가림"으로 보입니다. 상태는 /api/v1/health?deep=1입니다.
 */
import type { DeepHealthDto, OperatorMetricsDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '지표·상태 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const pick = (key: string) => (typeof route.query[key] === 'string' ? (route.query[key] as string) : undefined)
const range = reactive({ from: pick('from') ?? '', to: pick('to') ?? '' })
const query = computed(() => ({ ...(pick('from') && { from: pick('from') }), ...(pick('to') && { to: pick('to') }) }))

const { data: metrics, error } = await useFetch<OperatorMetricsDto>('/api/v1/operator/metrics', { query })
const { data: health, refresh: refreshHealth } = await useFetch<DeepHealthDto>('/api/v1/health', { query: { deep: 1 } })

const denied = computed(() => !!error.value && [401, 403].includes(error.value.statusCode ?? 0))
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const show = (v: number | null | undefined) => (v === null || v === undefined ? '가림(5 미만)' : String(v))
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '가림' : `${Math.round(v * 1000) / 10}%`)
const applyRange = () => navigateTo({ query: { ...(range.from && { from: range.from }), ...(range.to && { to: range.to }) } })
const STATUS_LABELS: Record<string, string> = { ok: '정상', error: '오류', stale: '응답 없음', missing: '기록 없음', halted: '안전장치로 멈춤', degraded: '점검 필요' }
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink> · <NuxtLink to="/operator/community-metrics">커뮤니티 지표</NuxtLink></p>
      <h1>pilot 지표</h1>
      <form class="actions" @submit.prevent="applyRange">
        <label>시작 <input v-model="range.from" type="date" /></label>
        <label>끝 <input v-model="range.to" type="date" /></label>
        <button type="submit">기간 적용</button>
      </form>
      <p v-if="error && !denied" class="notice error" role="alert">지표를 불러오지 못했습니다(기간을 확인하세요).</p>
      <template v-if="metrics">
        <p class="small muted">{{ formatDateTime(metrics.from) }} ~ {{ formatDateTime(metrics.to) }} · 만든 시각 {{ formatDateTime(metrics.generatedAt) }}</p>
        <table class="ledger-table">
          <thead><tr><th scope="col">지표</th><th scope="col">분모</th><th scope="col">분자</th><th scope="col">비율</th></tr></thead>
          <tbody>
            <tr><th scope="row">활성화(가입 7일 안에 과제 + 로그 3 + 근거 1)</th><td>{{ show(metrics.activation.denominator) }}</td><td>{{ show(metrics.activation.numerator) }}</td><td>{{ pct(metrics.activation.rate) }}</td></tr>
            <tr><th scope="row">기록 유지(4주 중 3주 이상)</th><td>{{ show(metrics.retention.denominator) }}</td><td>{{ show(metrics.retention.numerator) }}</td><td>{{ pct(metrics.retention.rate) }}</td></tr>
            <tr><th scope="row">사례 전환(후보 → 게시)</th><td>{{ show(metrics.caseConversion.denominator) }}</td><td>{{ show(metrics.caseConversion.numerator) }}</td><td>{{ pct(metrics.caseConversion.rate) }}</td></tr>
          </tbody>
        </table>
        <ul class="plain">
          <li>북극성(포크 + 도움됐어요): {{ show(metrics.northStar.total) }} (포크 {{ show(metrics.northStar.planForks) }}, 도움됐어요 {{ show(metrics.northStar.helpedMarks) }})</li>
          <li>기여 리포트 내보내기: {{ show(metrics.reportExports.exports) }}회, 과제 {{ show(metrics.reportExports.projects) }}개</li>
          <li>포트폴리오 공유한 사람: {{ show(metrics.portfolioSharers) }}</li>
          <li>선배 노트 게시: {{ show(metrics.seniorNotesPublished) }}</li>
          <li>기록 1회 작성 시간: 이벤트로 측정하지 않음</li>
        </ul>
        <h2>공개 프로필·팔로우(§6.2)</h2>
        <table class="ledger-table" data-testid="profile-metrics">
          <thead><tr><th scope="col">지표</th><th scope="col">분모</th><th scope="col">분자</th><th scope="col">비율</th></tr></thead>
          <tbody>
            <tr><th scope="row">팔로우 → 기록 활용(피드 사용자 중 도움됐어요·포크)</th><td>{{ show(metrics.profile.followToRecord.denominator) }}</td><td>{{ show(metrics.profile.followToRecord.numerator) }}</td><td>{{ pct(metrics.profile.followToRecord.rate) }}</td></tr>
            <tr><th scope="row">피드 구성(연 항목 중 기록)</th><td>{{ show(metrics.profile.feedComposition.denominator) }}</td><td>{{ show(metrics.profile.feedComposition.numerator) }}</td><td>{{ pct(metrics.profile.feedComposition.rate) }}</td></tr>
            <tr><th scope="row">표시명 사용(실명 → 표시명 프로필)</th><td>{{ show(metrics.profile.displayAdoption.denominator) }}</td><td>{{ show(metrics.profile.displayAdoption.numerator) }}</td><td>{{ pct(metrics.profile.displayAdoption.rate) }}</td></tr>
            <tr><th scope="row">팔로워 수 표시를 켠 공개 프로필(지금)</th><td>{{ show(metrics.profile.followerCountShown.denominator) }}</td><td>{{ show(metrics.profile.followerCountShown.numerator) }}</td><td>{{ pct(metrics.profile.followerCountShown.rate) }}</td></tr>
          </tbody>
        </table>
        <ul class="plain">
          <li>피드 사용자: {{ show(metrics.profile.feedUsers) }}</li>
          <li>표시명 사칭 신고: {{ show(metrics.profile.impersonation.reports) }}건, 숨김 확정 {{ show(metrics.profile.impersonation.confirmed) }}건</li>
          <li>
            신고: 프로필 {{ show(metrics.profile.reportsByTarget.persona) }} · 프로필 글 {{ show(metrics.profile.reportsByTarget.profilePost) }} · 소셜 링크
            {{ show(metrics.profile.reportsByTarget.socialLink) }} · 이전 실명 프로필 {{ show(metrics.profile.reportsByTarget.legacyProfile) }}
          </li>
          <li>주인 확인: {{ show(metrics.profile.ownerLookups) }}건(모두 신고와 이어짐)</li>
          <li>확인된 소셜 링크: {{ show(metrics.profile.socialLinksVerified.events) }}건, {{ show(metrics.profile.socialLinksVerified.users) }}명</li>
          <li>
            팔로우 요청 {{ show(metrics.profile.follows.requested) }}(대기 {{ show(metrics.profile.follows.pending) }}, 추천에서 {{ show(metrics.profile.follows.fromSuggestions) }}) · 승인
            {{ show(metrics.profile.follows.approved) }}
          </li>
          <li>
            차단 {{ show(metrics.profile.relationRemovals.blocks) }} · 뮤트 {{ show(metrics.profile.relationRemovals.mutes) }} · 팔로워 삭제
            {{ show(metrics.profile.relationRemovals.followerRemovals) }} · 활성 팔로우 1,000건당 {{ show(metrics.profile.relationRemovals.per1000Follows) }}
          </li>
          <li>연결 켜기 {{ show(metrics.profile.identityLink.turnedOn) }} · 끄기 {{ show(metrics.profile.identityLink.turnedOff) }} · 공개 범위 변경 {{ show(metrics.profile.settings.visibilityChanged) }} · 과제 수행 목록 {{ show(metrics.profile.settings.projectListed) }}</li>
          <li>정체성 누출(필수): 이벤트로 재지 않음 — 신고·사고 기록과 S-02 회귀 테스트로 확인</li>
        </ul>
        <details>
          <summary>이벤트별 개수</summary>
          <ul class="plain small">
            <li v-for="(n, name) in metrics.eventCounts" :key="name"><code>{{ name }}</code> {{ show(n) }}</li>
          </ul>
        </details>
        <ul class="small muted">
          <li v-for="note in metrics.notes" :key="note">{{ note }}</li>
        </ul>
      </template>

      <h2>시스템 상태</h2>
      <p v-if="!health" class="muted">상태를 불러오지 못했습니다.</p>
      <template v-else>
        <p>
          <strong>{{ STATUS_LABELS[health.status] ?? health.status }}</strong>
          <span class="small muted"> · {{ formatDateTime(health.checkedAt) }}</span>
          <button type="button" class="small" @click="refreshHealth()">다시 확인</button>
        </p>
        <p v-if="health.flags.maintenance || health.flags.publicReadsDisabled" class="notice error">
          <template v-if="health.flags.maintenance">점검 모드가 켜져 있습니다. </template>
          <template v-if="health.flags.publicReadsDisabled">공개 읽기 운영 스위치가 켜져 있습니다.</template>
        </p>
        <ul class="plain">
          <li>DB: {{ STATUS_LABELS[health.db.status] }} <span v-if="health.db.latencyMs !== null" class="muted">({{ health.db.latencyMs }}ms)</span></li>
          <li>저장소({{ health.storage.driver }}) 쓰기·읽기: {{ STATUS_LABELS[health.storage.status] }}</li>
          <li>worker: {{ STATUS_LABELS[health.worker.status] }} <span v-if="health.worker.ageSeconds !== null" class="muted">(마지막 기록 {{ health.worker.ageSeconds }}초 전)</span></li>
          <li>outbox 미전달: {{ health.outbox.backlog }}건<span v-if="health.outbox.oldestAgeSeconds !== null" class="muted">, 가장 오래된 것 {{ health.outbox.oldestAgeSeconds }}초</span></li>
          <li>
            실패 작업: <template v-if="!health.jobs.available">확인 불가</template>
            <template v-else>{{ Object.entries(health.jobs.failed).map(([k, v]) => `${k} ${v}`).join(', ') || '없음' }}</template>
            · dead-letter: {{ Object.entries(health.jobs.deadLetter).map(([k, v]) => `${k} ${v}`).join(', ') || '없음' }}
          </li>
          <li>정리가 늦은 탈퇴 계정(유예 {{ health.deletion.graceDays }}일 + 1일 지남): {{ health.deletion.overdue }}</li>
          <li data-testid="health-reports">
            처리 전 신고 묶음: {{ health.reports.open }} · 기한 넘김 {{ health.reports.overdue }}(임시 숨김 {{ health.reports.overdueAutoHidden }})
            <NuxtLink v-if="health.reports.overdue > 0" :to="{ path: '/operator', query: { status: 'open', overdue: '1' } }">기한 넘김 보기</NuxtLink>
          </li>
        </ul>
        <table v-if="health.tasks.length" class="ledger-table small">
          <thead><tr><th scope="col">주기 작업</th><th scope="col">마지막 실행</th><th scope="col">결과</th><th scope="col">처리 수</th></tr></thead>
          <tbody>
            <tr v-for="t in health.tasks" :key="t.name"><th scope="row"><code>{{ t.name }}</code></th><td>{{ formatDateTime(t.lastRunAt) }}</td><td>{{ STATUS_LABELS[t.status] ?? t.status }}</td><td>{{ t.affected ?? '-' }}</td></tr>
          </tbody>
        </table>
      </template>
    </template>
  </div>
</template>
