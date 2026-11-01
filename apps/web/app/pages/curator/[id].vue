<script setup lang="ts">
/**
 * 학생 큐레이터 화면(E-03, PROOFU_EVOLUTION_PLAN §8.6, ADR 0048). 그 과목 큐레이터(또는 운영자)가 아니면 404로 보입니다(API는 403 curator_only).
 * - 과제 유형 요약 쓰기(허브에 공개, 작성자 이름 없음), 개념 태그 병합 제안(운영자가 승인하면 병합), 팀원 찾기 끄기.
 * - 1차 신고 검토: 이 과목 허브 항목의 처리 전 신고(사유별 개수·지금 공개 중인 내용)에 "기각 권장 / 가리기 권장" 의견만 남깁니다.
 *   신고자·신고 설명·작성자는 보이지 않고, 처리·가리기·철회·계정 조치는 운영자가 합니다.
 */
import type { AssignmentTypeSummaryDto, CuratorReportGroupDto, CuratorWorkspaceDto, ConceptTagProposalDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '큐레이터 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const courseId = computed(() => String(route.params.id))
const { data, error, refresh } = await useFetch<CuratorWorkspaceDto>(() => `/api/v1/curator/courses/${courseId.value}`)
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const { data: reports, refresh: refreshReports } = await useFetch<CuratorReportGroupDto[]>(() => `/api/v1/curator/courses/${courseId.value}/reports`, {
  immediate: !!data.value && !data.value.operator,
})

const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const say = (kind: 'ok' | 'error', text: string) => (message.value = { kind, text })

// ── 과제 유형 요약 ──
const summaryBody = ref(data.value?.summary?.body ?? '')
watch(
  () => data.value?.summary,
  (s) => (summaryBody.value = s?.body ?? ''),
)
async function saveSummary() {
  busy.value = true
  message.value = null
  try {
    const res = await $fetch<{ summary: AssignmentTypeSummaryDto | null }>(`/api/v1/curator/courses/${courseId.value}/summary`, {
      method: 'PUT',
      body: { body: summaryBody.value, expectedVersion: data.value?.summary?.version ?? 0 },
    })
    say('ok', res.summary ? '과제 유형 요약을 저장했습니다.' : '과제 유형 요약을 비웠습니다.')
    await refresh()
  } catch (e) {
    const err = apiError(e)
    say('error', err.code === 'version_conflict' ? '다른 사람이 먼저 고쳤습니다. 새로 불러온 뒤 다시 저장하세요.' : err.code === 'validation_failed' ? '1000자 이하로 써 주세요.' : '저장하지 못했습니다.')
    if (err.code === 'version_conflict') await refresh()
  } finally {
    busy.value = false
  }
}

// ── 병합 제안 ──
const proposal = reactive({ sourceTagId: '', targetTagId: '', note: '' })
const PROPOSAL_ERRORS: Record<string, string> = {
  not_on_course: '원본 태그는 이 과목에 붙은 태그여야 합니다.',
  self: '서로 다른 태그를 고르세요.',
  not_found: '태그를 찾을 수 없습니다.',
  merged: '이미 병합된 태그입니다.',
}
async function propose() {
  busy.value = true
  message.value = null
  try {
    await $fetch<ConceptTagProposalDto>(`/api/v1/curator/courses/${courseId.value}/tag-merge-proposals`, {
      method: 'POST',
      body: { sourceTagId: proposal.sourceTagId, targetTagId: proposal.targetTagId, note: proposal.note || null },
    })
    say('ok', '병합을 제안했습니다. 운영자가 검토합니다.')
    Object.assign(proposal, { sourceTagId: '', targetTagId: '', note: '' })
    await refresh()
  } catch (e) {
    const err = apiError(e)
    const field = Object.values(err.fields ?? {})[0]
    say('error', err.code === 'already_proposed' ? '같은 제안이 이미 검토를 기다리고 있습니다.' : (field && PROPOSAL_ERRORS[field]) || '제안하지 못했습니다.')
  } finally {
    busy.value = false
  }
}
const STATUS_LABELS = { pending: '검토 대기', approved: '병합됨', rejected: '거절됨' } as const

// ── 팀원 찾기 ──
async function toggleTeamFinding() {
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/community/courses/${courseId.value}/team-finding`, { method: 'POST', body: { disabled: !data.value?.teamFindingDisabled } })
    await refresh()
  } catch {
    say('error', '바꾸지 못했습니다.')
  } finally {
    busy.value = false
  }
}

// ── 1차 신고 검토 ──
const notes = reactive<Record<string, string>>({})
async function recommend(g: CuratorReportGroupDto, recommendation: 'dismiss' | 'hide') {
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/curator/courses/${courseId.value}/reports/${g.reportId}/recommendation`, {
      method: 'PUT',
      body: { recommendation, note: notes[g.reportId] || null },
    })
    say('ok', '의견을 남겼습니다. 처리는 운영자가 합니다.')
    await refreshReports()
  } catch {
    say('error', '의견을 남기지 못했습니다(이미 처리된 신고일 수 있습니다).')
    await refreshReports()
  } finally {
    busy.value = false
  }
}
const reasonsText = (g: CuratorReportGroupDto) =>
  Object.entries(g.reasons)
    .map(([r, n]) => `${REPORT_REASON_LABELS[r as keyof typeof REPORT_REASON_LABELS]} ${n}`)
    .join(' · ')
</script>

<template>
  <div>
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
    </template>
    <template v-else-if="data">
      <p class="small muted">{{ data.course.schoolName }} · 학생 큐레이터</p>
      <h1>{{ data.course.title }}<template v-if="data.course.code"> ({{ data.course.code }})</template></h1>
      <p class="hint">
        큐레이터는 과제 유형 요약·개념 태그 병합 제안·1차 신고 검토(의견)·팀원 찾기 끄기만 합니다. 공개 철회·가리기·계정 조치·작성자 확인은 운영자가 합니다.
        <NuxtLink :to="`/c/${data.course.id}`">과목 허브 보기</NuxtLink>
      </p>
      <p v-if="message" :class="['notice', message.kind === 'error' ? 'error' : 'ok']" role="status">{{ message.text }}</p>

      <section aria-labelledby="cur-summary">
        <h2 id="cur-summary">과제 유형 요약</h2>
        <p class="hint">어떤 유형의 과제가 나오는지(개인·팀, 보고서·구현·발표, 대략의 흐름)만 짧게 씁니다. 답안·채점 기준·교수 평가는 쓰지 않습니다. 허브에 작성자 이름 없이 공개됩니다.</p>
        <form class="stack" @submit.prevent="saveSummary">
          <label for="cur-summary-body" class="visually-hidden">과제 유형 요약</label>
          <textarea id="cur-summary-body" v-model="summaryBody" rows="6" maxlength="1000" data-testid="curator-summary-body" />
          <p class="small muted">{{ summaryBody.length }} / 1000<template v-if="data.summary"> · {{ data.summary.version }}번째 판</template> · 비우고 저장하면 요약을 지웁니다.</p>
          <p class="actions"><button type="submit" :disabled="busy">저장</button></p>
        </form>
      </section>

      <section aria-labelledby="cur-tags">
        <h2 id="cur-tags">개념 태그 병합 제안</h2>
        <template v-if="data.operator">
          <p class="hint">운영자는 제안 없이 운영 화면에서 바로 병합합니다. <NuxtLink to="/operator/curators">병합 제안 대기열</NuxtLink></p>
        </template>
        <form v-else-if="data.conceptTags.length >= 2" class="stack" @submit.prevent="propose">
          <label>합칠 태그(이 과목)
            <select v-model="proposal.sourceTagId" required>
              <option value="" disabled>고르세요</option>
              <option v-for="t in data.conceptTags" :key="t.id" :value="t.id">#{{ t.label }}</option>
            </select>
          </label>
          <label>남길 태그
            <select v-model="proposal.targetTagId" required>
              <option value="" disabled>고르세요</option>
              <option v-for="t in data.conceptTags" :key="t.id" :value="t.id">#{{ t.label }}</option>
            </select>
          </label>
          <label>이유(선택, 300자)
            <input v-model="proposal.note" type="text" maxlength="300" />
          </label>
          <p class="actions"><button type="submit" :disabled="busy">병합 제안</button></p>
        </form>
        <p v-else class="muted">이 과목에 개념 태그가 두 개 이상 있어야 제안할 수 있습니다.</p>
        <ul v-if="data.proposals.length" class="plain small">
          <li v-for="p in data.proposals" :key="p.id">
            #{{ p.source.label }} → #{{ p.target.label }} · {{ STATUS_LABELS[p.status] }}<template v-if="p.mine"> · 내 제안</template>
          </li>
        </ul>
      </section>

      <section aria-labelledby="cur-team">
        <h2 id="cur-team">팀원 찾기</h2>
        <p>
          {{ data.teamFindingDisabled ? '이 과목은 팀원 찾기를 숨기고 있습니다(수업이 팀을 배정함).' : '이 과목에서 팀원 찾기를 쓸 수 있습니다.' }}
          <button type="button" class="secondary" :disabled="busy" @click="toggleTeamFinding">{{ data.teamFindingDisabled ? '다시 켜기' : '숨기기' }}</button>
        </p>
      </section>

      <section v-if="!data.operator" aria-labelledby="cur-reports" data-testid="curator-reports">
        <h2 id="cur-reports">1차 신고 검토</h2>
        <p class="hint">이 과목 허브의 처리 전 신고입니다. 신고한 사람·신고 설명·작성자는 보이지 않습니다. 의견만 남기고, 처리는 운영자가 합니다.</p>
        <ul v-if="reports?.length" class="plain operator-list">
          <li v-for="g in reports" :key="g.reportId">
            <p><strong>{{ g.targetLabel || REPORT_TARGET_LABELS[g.targetType] }}</strong> · {{ reasonsText(g) }}</p>
            <template v-if="g.content.kind === 'senior_note'">
              <dl class="small">
                <template v-for="(answer, q) in g.content.note.answers" :key="q"><dt>{{ SENIOR_NOTE_QUESTION_LABELS[q] ?? q }}</dt><dd class="pre">{{ answer }}</dd></template>
              </dl>
            </template>
            <p v-else-if="g.content.kind === 'course_qa'" class="small pre">{{ g.content.qa.questionTitle }} — {{ g.content.qa.answerBody }}</p>
            <p v-else-if="g.content.kind === 'publication'" class="small">{{ g.content.title }} — {{ g.content.summary }}</p>
            <p v-else class="small muted">{{ g.content.message }}</p>
            <p v-if="g.publicPath" class="small"><NuxtLink :to="g.publicPath">공개 화면에서 보기</NuxtLink></p>
            <p v-if="g.myRecommendation" class="small">내 의견: {{ g.myRecommendation.recommendation === 'hide' ? '가리기 권장' : '기각 권장' }}</p>
            <p class="actions small">
              <input v-model="notes[g.reportId]" type="text" maxlength="300" placeholder="운영자에게 남길 메모(선택)" :aria-label="`${g.targetLabel} 메모`" />
              <button type="button" class="secondary" :disabled="busy" @click="recommend(g, 'dismiss')">기각 권장</button>
              <button type="button" class="secondary" :disabled="busy" @click="recommend(g, 'hide')">가리기 권장</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">검토할 신고가 없습니다.</p>
      </section>
    </template>
  </div>
</template>
