<script setup lang="ts">
/**
 * 아카이브로 옮기기 요청(C-09, ADR 0025). 요청한 사람과 동의를 요청받은 사람만 봅니다(원 글 공간을 지금 읽을 수 있어야 함, 아니면 404). 로그인 전용·noindex.
 * - 동의할 사람: 옮겨질 글 그대로(요청 때 얼린 것)·질문한 학생이 고른 이름·공개 전 점검 경고를 보고, 자기 이름을 고른 뒤 동의하거나 거절합니다.
 * - 요청한 사람: 답한 학생의 동의 상태만 봅니다(누구인지·고른 이름은 보이지 않음). 동의를 기다리는 동안 취소할 수 있습니다.
 * - 막힘 Q&A로 옮겨진 뒤에는 두 사람 모두 언제든 공개를 철회할 수 있습니다(즉시 사라짐).
 */
import type { ArchiveTransferDto, MyCourseQaDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const fetcher = useRequestFetch()
const { data: t, error } = await useAsyncData(`archive-transfer-${id.value}`, () => fetcher<ArchiveTransferDto>(`/api/v1/community/archive-transfers/${id.value}`))
const missing = computed(() => !!error.value || !t.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const display = ref<'anonymous' | 'display' | 'real'>('anonymous')
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const FIELD_LABELS: Record<string, string> = { questionTitle: '질문 제목', questionBody: '질문 본문', answerBody: '답변' }

function fail(e: unknown) {
  const err = apiError(e)
  const text = err.code === 'validation_failed' ? archiveFieldErrors(err.fields).join(' ') : communityErrorMessage(err.code)
  notice.value = { kind: 'error', text }
}

async function decide(decision: 'grant' | 'decline') {
  if (!t.value) return
  if (decision === 'decline' && !window.confirm('동의하지 않으면 이 요청은 취소되고 아무것도 옮겨지지 않습니다. 거절할까요?')) return
  busy.value = true
  notice.value = null
  try {
    const body: Record<string, unknown> = { decision }
    if (decision === 'grant') {
      body.contentHash = t.value.contentHash
      if (t.value.target === 'course_qa') body.displayMode = display.value
    }
    t.value = await $fetch<ArchiveTransferDto>(`/api/v1/community/archive-transfers/${id.value}/consents`, { method: 'POST', body })
    notice.value = { kind: 'ok', text: decision === 'grant' ? (t.value.status === 'done' ? '동의했습니다. 옮기기가 끝났습니다.' : '동의했습니다.') : '거절했습니다. 요청이 취소되었습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function cancel() {
  if (!window.confirm('이 요청을 취소할까요?')) return
  busy.value = true
  try {
    t.value = await $fetch<ArchiveTransferDto>(`/api/v1/community/archive-transfers/${id.value}/cancel`, { method: 'POST' })
    notice.value = { kind: 'ok', text: '요청을 취소했습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function withdrawQa(qa: MyCourseQaDto) {
  if (!window.confirm('막힘 Q&A를 공개에서 내릴까요? 과목 페이지와 검색에서 바로 사라집니다.')) return
  busy.value = true
  try {
    const updated = await $fetch<MyCourseQaDto>(`/api/v1/course-qa/${qa.id}/withdraw`, { method: 'POST' })
    if (t.value) t.value = { ...t.value, result: { ...t.value.result, courseQa: updated } }
    notice.value = { kind: 'ok', text: '공개를 철회했습니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: courseHubErrorMessage(apiError(e).code) }
  } finally {
    busy.value = false
  }
}

const QA_STATUS: Record<MyCourseQaDto['status'], string> = { published: '공개 중', withdrawn: '철회됨', hidden: '운영 조치로 숨겨짐' }
</script>

<template>
  <div class="community-page">
    <template v-if="missing">
      <h1>요청을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 요청을 볼 수 없습니다.</p>
      <p><NuxtLink to="/community/notices">커뮤니티 알림으로</NuxtLink></p>
    </template>
    <template v-else-if="t">
      <h1>아카이브로 옮기기</h1>
      <p class="small">
        <span class="badge">{{ ARCHIVE_TARGET_LABELS[t.target] }}</span>
        <span class="badge" data-testid="transfer-status">{{ ARCHIVE_STATUS_LABELS[t.status] }}</span>
        <template v-if="t.course"> · 과목: {{ t.course.schoolName }} {{ t.course.title }} <span class="badge">학생 작성</span></template>
        <template v-if="t.project"> · 과제: {{ t.project.title }}</template>
        <template v-else-if="t.target === 'stuck_log'"> · 질문한 학생의 비공개 과제</template>
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <p v-if="t.status === 'cancelled'" class="notice" role="status">{{ t.cancelText }}</p>
      <p v-if="t.status === 'awaiting_consent'" class="small muted">동의 기한: {{ formatDateTime(t.expiresAt) }}</p>

      <p v-if="t.counterpart" class="notice" role="status" data-testid="counterpart-status">{{ t.counterpart.text }}</p>

      <section v-if="t.preview" aria-labelledby="preview-title" class="stack">
        <h2 id="preview-title">옮겨질 글</h2>
        <p class="hint">요청 때의 글 그대로입니다. 원 글을 나중에 고쳐도 이 내용이 옮겨집니다. 원 글은 커뮤니티에 그대로 남습니다.</p>
        <div class="hub-card" data-testid="transfer-preview">
          <p><strong>Q. {{ t.preview.questionTitle }}</strong></p>
          <p v-if="t.preview.askerLabel" class="small muted">질문한 학생 표시: {{ t.preview.askerLabel }}</p>
          <p class="pre preview-text">{{ t.preview.questionBody }}</p>
          <template v-if="t.preview.answerBody">
            <p><strong>A.</strong></p>
            <p class="pre preview-text">{{ t.preview.answerBody }}</p>
          </template>
        </div>
        <div v-if="t.warnings.length" class="notice" role="status">
          <p><strong>공개 전 점검 경고</strong></p>
          <ul>
            <li v-for="(w, i) in t.warnings" :key="i">{{ CHECK_RULE_LABELS[w.rule] ?? w.rule }} · {{ FIELD_LABELS[w.field] ?? w.field }} · {{ w.sample }}</li>
          </ul>
        </div>
      </section>

      <form v-if="t.canDecide" class="stack" novalidate @submit.prevent="decide('grant')">
        <fieldset v-if="t.displayOptions">
          <legend>막힘 Q&amp;A에 보일 내 이름</legend>
          <div class="radio-row">
            <input id="consent-anon" v-model="display" type="radio" name="consent-display" value="anonymous" />
            <label for="consent-anon">익명("{{ t.displayOptions.anonymousLabel }}")</label>
          </div>
          <div v-if="t.displayOptions.displayName" class="radio-row">
            <input id="consent-display" v-model="display" type="radio" name="consent-display" value="display" />
            <label for="consent-display">표시명({{ t.displayOptions.displayName }})</label>
          </div>
          <div v-if="t.displayOptions.realName" class="radio-row">
            <input id="consent-real" v-model="display" type="radio" name="consent-display" value="real" />
            <label for="consent-real">실명({{ t.displayOptions.realName }})</label>
          </div>
          <p class="hint">질문한 학생에게는 내가 누구인지, 무엇을 골랐는지 알리지 않습니다. 공개된 뒤에는 고른 이름이 보입니다.</p>
        </fieldset>
        <p v-else class="hint">질문한 학생의 비공개 과제에 💡 해결 로그로 복사됩니다. 공개되지 않습니다.</p>
        <p class="actions">
          <button type="submit" :disabled="busy" data-testid="consent-grant">동의하고 옮기기</button>
          <button type="button" class="secondary" :disabled="busy" data-testid="consent-decline" @click="decide('decline')">동의하지 않음</button>
        </p>
      </form>
      <p v-else-if="t.myConsent && t.myRole === 'party'" class="small muted">내 결정: {{ t.myConsent.status === 'granted' ? '동의함' : t.myConsent.status === 'declined' ? '거절함' : '대기 중' }}</p>

      <p v-if="t.canCancel" class="actions"><button type="button" class="secondary" :disabled="busy" @click="cancel">요청 취소</button></p>

      <section v-if="t.status === 'done'" aria-labelledby="result-title" class="stack">
        <h2 id="result-title">옮겨진 곳</h2>
        <template v-if="t.result.courseQa">
          <p data-testid="course-qa-status">
            막힘 Q&amp;A · {{ QA_STATUS[t.result.courseQa.status] }} · 내 이름 표시 "{{ t.result.courseQa.myLabel }}"
            <NuxtLink v-if="t.result.courseQa.path" :to="t.result.courseQa.path">과목 페이지에서 보기</NuxtLink>
          </p>
          <p v-if="t.result.courseQa.status !== 'withdrawn'" class="actions">
            <button type="button" class="secondary" :disabled="busy" data-testid="qa-withdraw" @click="withdrawQa(t.result.courseQa)">공개 철회</button>
          </p>
        </template>
        <p v-if="t.result.seniorNoteId && t.course"><NuxtLink :to="`/senior-notes?course=${t.course.id}`">선배 노트 초안 고치고 게시하기</NuxtLink></p>
        <p v-if="t.result.projectId"><NuxtLink :to="`/projects/${t.result.projectId}`">과제에서 막힘 로그 보기</NuxtLink></p>
      </section>

      <p><NuxtLink :to="`/community/p/${t.postId}`">원 글로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>

<style scoped>
.preview-text {
  overflow-wrap: anywhere;
}
</style>
