<script setup lang="ts">
/**
 * 커뮤니티 지표·운영 시간 합계·CSV 내보내기(C-10, DELIVERY_PLAN §6.1·§7 GC, ADR 0027). 운영자가 아니면 404로 보입니다(API는 403 operator_only).
 * 모든 칸은 5 미만이면 "가림"입니다. 공간별 보기는 운영자가 고른 공간 하나만(active 멤버 기준 이상), 내보내기에는 없습니다.
 */
import type { CommunityMetricsDto, CommunityMetricsSpaceOptionDto, RateMetricDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '커뮤니티 지표 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const pick = (key: string) => (typeof route.query[key] === 'string' && route.query[key] ? (route.query[key] as string) : undefined)
const form = reactive({ from: pick('from') ?? '', to: pick('to') ?? '', space: pick('space') ?? '' })
const query = computed(() => ({ ...(pick('from') && { from: pick('from') }), ...(pick('to') && { to: pick('to') }), ...(pick('space') && { space: pick('space') }) }))

const { data: m, error } = await useFetch<CommunityMetricsDto>('/api/v1/operator/metrics/community', { query })
const { data: spaces } = await useFetch<CommunityMetricsSpaceOptionDto[]>('/api/v1/operator/metrics/community/spaces')

const denied = computed(() => !!error.value && [401, 403].includes(error.value.statusCode ?? 0))
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const errorText = computed(() => {
  if (!error.value || denied.value) return null
  const code = (error.value.data as { data?: { code?: string } } | undefined)?.data?.code
  if (code === 'space_too_small') return '이 공간은 active 멤버가 기준보다 적어 공간별로 볼 수 없습니다.'
  if (error.value.statusCode === 404) return '공간을 찾을 수 없습니다.'
  return '지표를 불러오지 못했습니다(기간을 확인하세요).'
})

const show = (v: number | null | undefined) => (v === null || v === undefined ? '가림' : String(v))
const pct = (r: RateMetricDto) => (r.rate === null ? '가림' : `${Math.round(r.rate * 1000) / 10}%`)
const rateText = (r: RateMetricDto) => `${pct(r)} (${show(r.numerator)} / ${show(r.denominator)})`
const apply = () =>
  navigateTo({ query: { ...(form.from && { from: form.from }), ...(form.to && { to: form.to }), ...(form.space && { space: form.space }) } })
const exportHref = computed(() => {
  const q = new URLSearchParams({ ...(pick('from') && { from: pick('from')! }), ...(pick('to') && { to: pick('to')! }) }).toString()
  return `/api/v1/operator/metrics/community/export${q ? `?${q}` : ''}`
})

const BOARD_LABELS: Record<string, string> = { free: '자유', freshmen: '새내기', alumni: '졸업생', question: '질문', info: '정보', recruiting: '모집', notice: '공지', general: '일반' }
const MODE_LABELS: Record<string, string> = { real: '실명', display: '표시명', anonymous: '익명' }
const LEVEL_LABELS: Record<string, string> = { warning: '경고', write_suspended: '쓰기 기간 제한', permanent: '영구 제한' }
const TARGET_LABELS: Record<string, string> = { course_qa: '막힘 Q&A', stuck_log: '막힘 로그', senior_note: '선배 노트' }
const CATEGORY_LABELS: Record<string, string> = { reports: '신고 검토', official_pages: '공식 페이지', affiliation_support: '학교 인증 지원', curation: '큐레이션', other: '기타' }
const NA_LABELS: Record<string, string> = { archiveInflow: '아카이브 유입', revisit: '재방문', writeTime: '작성 시간', studyToSeniorNote: '스터디 → 선배 노트' }
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink> · <NuxtLink to="/operator/ops-time">주간 운영 시간 기록</NuxtLink> · <NuxtLink to="/operator/metrics">pilot 지표·상태</NuxtLink></p>
      <h1>커뮤니티 지표</h1>
      <form class="actions" @submit.prevent="apply">
        <label>시작 <input v-model="form.from" type="date" /></label>
        <label>끝 <input v-model="form.to" type="date" /></label>
        <label>
          공간별 보기
          <select v-model="form.space">
            <option value="">전체(공간 구분 없음)</option>
            <option v-for="s in spaces ?? []" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <button type="submit">적용</button>
      </form>
      <p class="hint">공간별 보기는 active 멤버가 기준(기본 20명) 이상인 공간만 고를 수 있습니다. 내보내기 CSV에는 공간별 값·이름·id가 없습니다.</p>
      <p v-if="errorText" class="notice error" role="alert">{{ errorText }}</p>
      <template v-if="m">
        <p class="small muted">{{ formatDateTime(m.from) }} ~ {{ formatDateTime(m.to) }} · 만든 시각 {{ formatDateTime(m.generatedAt) }}</p>
        <p class="actions"><a :href="exportHref" download data-testid="metrics-export">CSV 내보내기(집계만)</a></p>

        <section aria-labelledby="cm-moderation">
          <h2 id="cm-moderation">신고·처리 시간</h2>
          <ul class="plain" data-testid="cm-moderation">
            <li>신고 접수(전체 대상): {{ show(m.moderation.reportsFiled) }} · 커뮤니티 신고 {{ show(m.moderation.communityReportsFiled) }}</li>
            <li>글 100건당 신고: {{ show(m.moderation.reportsPer100Posts) }} (1,000건당 {{ show(m.moderation.reportsPer1000Posts) }})</li>
            <li>처리한 묶음: {{ show(m.moderation.casesClosed) }} · 첫 조치까지 중앙값 {{ show(m.moderation.medianFirstActionHours) }}시간 · 처리까지 중앙값 {{ show(m.moderation.medianResolutionHours) }}시간</li>
            <li>자동 숨김 → 검토 완료 중앙값: {{ show(m.moderation.medianAutoHiddenResolutionHours) }}시간(목표 24시간 이내)</li>
            <li>기한 안 처리: {{ rateText(m.moderation.slaMet) }} · 기한 {{ m.slaTargets.autoHiddenHours }}시간(임시 숨김)·{{ m.slaTargets.normalHours }}시간(그 밖)</li>
            <li>신고된 글·댓글 중 임시 숨김: {{ rateText(m.moderation.autoHideRate) }} · 처리된 임시 숨김 중 복원: {{ rateText(m.moderation.restoreRate) }}</li>
            <li>지금 처리 전: {{ show(m.moderation.openCases) }} · 기한 넘김 {{ show(m.moderation.overdueCases) }}(임시 숨김 {{ show(m.moderation.overdueAutoHidden) }})</li>
            <li>
              이용 제한:
              <span v-for="(n, level) in m.moderation.sanctionsByLevel" :key="level">{{ LEVEL_LABELS[level] }} {{ show(n) }} </span>
            </li>
            <li>작성자 확인: {{ show(m.moderation.authorLookups) }} · 신고·제재 요청과 이어진 비율 {{ rateText(m.moderation.authorLookupsLinked) }}(목표 100%)</li>
          </ul>
        </section>

        <section aria-labelledby="cm-conversion">
          <h2 id="cm-conversion">아카이브 전환</h2>
          <ul class="plain">
            <li><strong>질문 → 막힘 Q&A·막힘 로그</strong>: {{ rateText(m.conversion.questionToStuck) }}</li>
            <li><strong>스터디 방 → 스터디 기록(3주 이상)</strong>: {{ rateText(m.conversion.studyRecordConversion) }}</li>
            <li>스터디 기록 켬: {{ show(m.conversion.studyRecordsEnabled) }} · 기록 있는 스터디 중 공개 사례 게시 {{ rateText(m.conversion.studyPublished) }}</li>
            <li v-for="(t, key) in m.conversion.transfers" :key="key">옮기기({{ TARGET_LABELS[key] }}): 요청 {{ show(t.requested) }} → 완료 {{ show(t.completed) }}</li>
            <li>모집: 팀 {{ show(m.conversion.recruitmentsCreated.team) }} · 스터디 {{ show(m.conversion.recruitmentsCreated.study) }} · 끝난 모집 중 성사 {{ rateText(m.conversion.recruitmentFillRate) }}</li>
          </ul>
        </section>

        <section aria-labelledby="cm-writing">
          <h2 id="cm-writing">활동·글쓰기</h2>
          <div class="table-scroll" role="region" aria-labelledby="cm-writing" tabindex="0">
            <table class="ledger-table">
              <thead><tr><th scope="col">주(서울 ISO)</th><th scope="col">주간 활성(키 있는 행동)</th></tr></thead>
              <tbody>
                <tr v-for="w in m.activity.weeklyActive" :key="w.week"><th scope="row">{{ w.week }}</th><td>{{ show(w.users) }}</td></tr>
              </tbody>
            </table>
          </div>
          <ul class="plain">
            <li>글 {{ show(m.writing.posts) }} · 댓글 {{ show(m.writing.comments) }} · 익명 비율 {{ rateText(m.writing.anonymousShare) }} · 표시명·실명 비율 {{ rateText(m.writing.namedShare) }}</li>
            <li>게시판별 글: <span v-for="(n, k) in m.writing.postsByBoard" :key="k">{{ BOARD_LABELS[k] }} {{ show(n) }} </span></li>
            <li>방식별 글: <span v-for="(n, k) in m.writing.postsByMode" :key="k">{{ MODE_LABELS[k] }} {{ show(n) }} </span> · 댓글: <span v-for="(n, k) in m.writing.commentsByMode" :key="k">{{ MODE_LABELS[k] }} {{ show(n) }} </span></li>
            <li class="small muted">사용자 키 없는 이벤트 {{ show(m.activity.unkeyedEvents) }} · 키 있는 이벤트 {{ show(m.activity.keyedEvents) }}</li>
          </ul>
        </section>

        <section v-if="m.space" aria-labelledby="cm-space" data-testid="cm-space">
          <h2 id="cm-space">고른 공간(멤버 {{ m.space.minMembers }}명 이상)</h2>
          <ul class="plain">
            <li>게시판별 글: <span v-for="(n, k) in m.space.postsByBoard" :key="k">{{ BOARD_LABELS[k] }} {{ show(n) }} </span></li>
            <li>익명 비율 {{ rateText(m.space.anonymousShare) }} · 익명 아닌 글쓴이 {{ show(m.space.namedWriters) }} · 신고 묶음 {{ show(m.space.reportCases) }} · 임시 숨김 {{ show(m.space.autoHidden) }}</li>
          </ul>
        </section>

        <section aria-labelledby="cm-time">
          <h2 id="cm-time">주간 운영 시간(합계, 분)</h2>
          <div class="table-scroll" role="region" aria-labelledby="cm-time" tabindex="0">
            <table class="ledger-table" data-testid="cm-ops-time">
              <thead>
                <tr><th scope="col">주</th><th v-for="(label, k) in CATEGORY_LABELS" :key="k" scope="col">{{ label }}</th><th scope="col">합계</th><th scope="col">기록한 운영자</th></tr>
              </thead>
              <tbody>
                <tr v-for="w in m.opsTime.weeks" :key="w.week">
                  <th scope="row">{{ w.week }}</th>
                  <td v-for="(_, k) in CATEGORY_LABELS" :key="k">{{ show(w.minutes[k as keyof typeof w.minutes]) }}</td>
                  <td>{{ show(w.total) }}</td>
                  <td>{{ show(w.operators) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="cm-na">
          <h2 id="cm-na">재지 않는 지표</h2>
          <ul class="plain small">
            <li v-for="(v, k) in m.notAvailable" :key="k"><strong>{{ NA_LABELS[k] }}</strong>: {{ v.reason }}</li>
          </ul>
        </section>
        <ul class="small muted">
          <li v-for="note in m.notes" :key="note">{{ note }}</li>
        </ul>
      </template>
    </template>
  </div>
</template>
