<script setup lang="ts">
/**
 * 동료평가용 기여 리포트(T-08, PROOFU_EVOLUTION_PLAN §7 "동료평가 리포트", ADR 0008).
 * - 인쇄에 맞춘 HTML 페이지입니다. 브라우저의 인쇄 → "PDF로 저장"으로 PDF를 만듭니다(서버 PDF 생성 없음).
 * - 이 과제의 멤버만 열 수 있고(아니면 API가 404), 이 과제의 자료만 담습니다. 이메일·내부 id를 싣지 않습니다.
 * - 멤버별 역할 선언(상태·근거 제목)과 기간 기록의 종류별 개수, "개수는 참고용" 문장, 만든 시각을 넣습니다.
 *   점수·비율·순위는 없고 멤버는 이름순입니다.
 * - 화면 상단의 도구 막대(돌아가기·인쇄)는 인쇄물에 나오지 않습니다. 사이트 머리글도 쓰지 않습니다(layout 없음).
 */
import type { ContributionDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth', layout: false })

const route = useRoute()
const id = computed(() => String(route.params.id))
const query = computed(() => {
  const pick = (key: string) => (typeof route.query[key] === 'string' ? (route.query[key] as string) : undefined)
  const from = pick('from')
  const to = pick('to')
  return from && to ? { from, to } : {}
})

const { data, error } = await useFetch<ContributionDto>(() => `/api/v1/projects/${id.value}/contribution`, { query })

useHead({
  title: () => (data.value ? `${data.value.project.title} 기여 리포트 — Peerchive` : '기여 리포트 — Peerchive'),
  meta: [{ name: 'robots', content: 'noindex' }],
})

const generated = computed(() =>
  data.value
    ? new Date(data.value.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' })
    : '',
)
const printReport = () => {
  // 인쇄(PDF로 저장)를 했다는 표시만 남깁니다(pilot 지표 report_exported, 실패해도 인쇄는 그대로).
  $fetch(`/api/v1/projects/${id.value}/report-exports`, { method: 'POST', body: { ...query.value } }).catch(() => {})
  window.print()
}
</script>

<template>
  <div class="report-shell">
    <nav class="report-toolbar no-print" aria-label="리포트 도구">
      <NuxtLink :to="`/projects/${id}`">← 과제로 돌아가기</NuxtLink>
      <button v-if="data" type="button" @click="printReport">인쇄 / PDF로 저장</button>
    </nav>

    <main id="main" class="report">
      <template v-if="error || !data">
        <h1>리포트를 열 수 없습니다</h1>
        <p v-if="error?.statusCode === 422">기간이 올바르지 않습니다. 과제 화면에서 기간을 다시 고르세요.</p>
        <p v-else>없는 과제이거나 볼 수 있는 권한이 없습니다.</p>
      </template>

      <template v-else>
        <header class="report-header">
          <p class="report-kicker">동료평가용 기여 리포트</p>
          <h1>{{ data.project.title }}</h1>
          <dl class="report-meta">
            <dt>기간</dt>
            <dd>
              {{ formatPeriod(data.period.from, data.period.to) }} (한국 시간)<template v-if="data.period.weekNo"> · {{ data.period.weekNo }}주차</template>
            </dd>
            <dt>만든 시각</dt>
            <dd>{{ generated }}</dd>
          </dl>
          <p class="report-note">
            팀 비공개 자료입니다. 상태 표시: <strong>본인 설명 · 미확인</strong>(팀원 확인 전),
            <strong>팀원 확인 N명</strong>(그 팀원이 선언을 인정함 — 교수 인증·능력 검증이 아님),
            <strong>이의 있음</strong>(팀원이 다르다고 메모를 남김). 선언은 지금 상태이고, 개수는 위 기간의 기록입니다.
          </p>
          <p class="report-disclaimer">{{ data.disclaimer }}</p>
        </header>

        <section v-for="row in data.members" :key="row.member.userId" class="report-member" :aria-labelledby="`m-${row.member.userId}`">
          <h2 :id="`m-${row.member.userId}`">
            {{ row.member.displayName || '이름 미설정' }}<span v-if="!row.active" class="report-muted"> (나간 멤버)</span>
          </h2>

          <h3>역할 선언</h3>
          <p v-if="row.claims.length === 0" class="report-muted">선언 없음</p>
          <ol v-else class="report-claims">
            <li v-for="claim in row.claims" :key="claim.id" class="report-claim">
              <p>
                <strong>“{{ claim.text }}”</strong> — {{ claimStatusLabel(claim) }}
                <span class="report-muted">(버전 {{ claim.revisionNo }})</span>
              </p>
              <p v-if="claim.endorsements.length" class="report-small">
                팀원 응답:
                <template v-for="(e, i) in claim.endorsements" :key="e.endorser.userId">
                  {{ i > 0 ? ' / ' : '' }}{{ e.endorser.displayName || '이름 미설정' }} {{ e.status === 'confirmed' ? '확인' : '이의' }}<template v-if="e.note"> “{{ e.note }}”</template>
                </template>
              </p>
              <p v-if="claim.evidence.length" class="report-small">근거: {{ claim.evidence.map(evidenceLabel).join(' / ') }}</p>
              <p v-else class="report-small report-muted">근거 없음</p>
            </li>
          </ol>

          <h3>기간 기록</h3>
          <table class="report-counts">
            <tbody>
              <tr>
                <th scope="row">빌드 로그(종류별)</th>
                <td>{{ activityParts(row).join(' · ') || '없음' }}</td>
              </tr>
              <tr>
                <th scope="row">완료한 할 일</th>
                <td>{{ row.tasksCompleted }}</td>
              </tr>
              <tr>
                <th scope="row">올린 파일(검사 통과)</th>
                <td>{{ row.artifactsUploaded }}</td>
              </tr>
              <tr>
                <th scope="row">회의 참석</th>
                <td>{{ row.meetingsAttended }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="data.unresolvedStuck.length" class="report-member" aria-labelledby="unresolved-heading">
          <h2 id="unresolved-heading">기간 끝까지 해결 로그가 없는 막힘</h2>
          <ul class="report-small">
            <li v-for="s in data.unresolvedStuck" :key="s.id">“{{ s.summary }}” — {{ s.author.displayName || '이름 미설정' }}, {{ s.openDays }}일째</li>
          </ul>
        </section>

        <footer class="report-footer">
          <p>{{ data.disclaimer }}</p>
          <p class="report-muted">Peerchive · {{ generated }} 생성 · 활동량을 점수·비율·순위로 바꾸지 않습니다.</p>
        </footer>
      </template>
    </main>
  </div>
</template>
