<script setup lang="ts">
/**
 * 면접 준비 팩(E-06, PROOFU_EVOLUTION_PLAN §10.5, ADR 0050). 케이스 스터디 편집 화면 아래에 붙습니다(작성자만 보는 화면).
 * - 질문은 케이스 문장이 인용한 결정·회의·막힘 기록으로 만든 템플릿 질문 + 일반 질문(실패·의견 충돌·다시 한다면)입니다. 근거 칩은 그 공개 기록으로 갑니다.
 * - 답변 메모는 **나만 봅니다**(공개 프로필·인쇄·README 카드·검색 어디에도 나오지 않음).
 * - "공개 프로필에 이 질문 보이기"는 질문 글만 "이 지원자에게 물어보면 좋은 질문"으로 보입니다. 케이스가 게시 중이고 실명 프로필 판의 대표 케이스일 때만.
 * - 케이스를 고치면(version이 바뀌면) 질문을 다시 불러옵니다. 지금 만들어지지 않는 질문의 메모는 "보관된 메모"로 남고 지울 수 있습니다.
 */
import type { InterviewPrepDto, InterviewQuestionDto } from '~~/shared/types/api'

const props = defineProps<{ caseStudyId: string; version: number }>()

const pack = ref<InterviewPrepDto | null>(null)
const drafts = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const loadError = ref(false)

async function load() {
  loadError.value = false
  try {
    apply(await $fetch<InterviewPrepDto>(`/api/v1/case-studies/${props.caseStudyId}/interview-prep`))
  } catch {
    loadError.value = true
  }
}
function apply(dto: InterviewPrepDto) {
  pack.value = dto
  for (const q of dto.questions) drafts[q.key] = q.note ?? ''
}
onMounted(load)
watch(() => props.version, load)

const ERROR_TEXT: Record<string, string> = {
  limit_reached: '이 사례에 남길 수 있는 메모 수를 넘었습니다. 보관된 메모를 지워 주세요.',
  rate_limited: '잠시 뒤 다시 시도하세요.',
}

async function save(key: string, body: { note?: string | null; shown?: boolean }, done: string) {
  busy.value = key
  message.value = null
  try {
    apply(await $fetch<InterviewPrepDto>(`/api/v1/case-studies/${props.caseStudyId}/interview-prep`, { method: 'PUT', body: { questionKey: key, ...body } }))
    message.value = { kind: 'ok', text: done }
  } catch (e) {
    const err = apiError(e)
    message.value = {
      kind: 'error',
      text: err.fields.note ? `메모: ${fieldText(err.fields.note)}` : err.fields.questionKey ? '지금 이 사례에서 만들어지지 않는 질문입니다.' : (ERROR_TEXT[err.code] ?? '저장하지 못했습니다.'),
    }
    if (err.status === 422) await load()
  } finally {
    busy.value = null
  }
}

const saveNote = (q: InterviewQuestionDto) => save(q.key, { note: drafts[q.key] ?? '' }, '메모를 저장했습니다(나만 봄).')
const toggleShown = (q: InterviewQuestionDto) =>
  save(q.key, { shown: !q.shown }, q.shown ? '공개 프로필에서 이 질문을 내렸습니다.' : '공개 프로필에 이 질문을 보이기로 했습니다(답변 메모는 공개되지 않음).')
const dropArchived = (key: string) => save(key, { note: null, shown: false }, '보관된 메모를 지웠습니다.')
</script>

<template>
  <section class="interview-prep" aria-labelledby="interview-prep-heading" data-testid="interview-prep">
    <h2 id="interview-prep-heading">면접 준비 팩</h2>
    <p class="hint">
      이 케이스가 인용한 결정·막힘 기록으로 만든 예상 질문입니다. 답변 메모는 나만 봅니다. 고른 질문의 <strong>글만</strong> 공개 프로필에
      “{{ INTERVIEW_PUBLIC_HEADING }}”으로 보입니다(실명 프로필 판의 대표 케이스이고 게시 중일 때만).
    </p>
    <p v-if="loadError" class="notice error" role="alert">면접 준비 팩을 불러오지 못했습니다.</p>
    <template v-else-if="pack">
      <p v-if="!pack.available" class="notice small" role="note">원본 사례를 더 이상 볼 수 없어 질문이 없습니다. 남은 메모는 아래 “보관된 메모”에 있습니다.</p>
      <p v-else-if="!pack.publiclyVisible && pack.questions.some((q) => q.shown)" class="notice small" role="note">
        지금은 이 케이스가 공개 프로필에 보이지 않아, 고른 질문도 보이지 않습니다.
      </p>
      <ol class="plain interview-questions">
        <li v-for="q in pack.questions" :key="q.key" class="interview-question" :data-question-key="q.key">
          <p>
            <span class="badge">{{ q.categoryLabel }}</span> <strong>{{ q.text }}</strong>
          </p>
          <p class="small">
            <template v-if="q.source">근거: <a v-if="q.source.path" class="chip static citation-chip" :href="q.source.path">{{ q.source.label ?? '공개 기록' }}</a></template>
            <span v-else class="muted">일반 질문(근거 기록 없음)</span>
          </p>
          <p v-if="q.textChanged" class="small muted">메모를 쓴 뒤 질문 글이 바뀌었습니다(케이스 수정 또는 새 공개 버전). 메모를 다시 확인하세요.</p>
          <div class="field">
            <label :for="`ip-note-${q.key}`">내 답변 메모 <span class="muted small">(나만 봄)</span></label>
            <textarea :id="`ip-note-${q.key}`" v-model="drafts[q.key]" rows="3" :maxlength="INTERVIEW_NOTE_MAX" />
          </div>
          <p class="actions">
            <button type="button" class="secondary" :disabled="busy === q.key || (drafts[q.key] ?? '') === (q.note ?? '')" @click="saveNote(q)">메모 저장</button>
            <label class="check small">
              <input type="checkbox" :checked="q.shown" :disabled="busy === q.key" @change="toggleShown(q)" />
              공개 프로필에 이 질문 보이기
            </label>
          </p>
        </li>
      </ol>
      <p v-if="pack.available && !pack.questions.length" class="muted small">만들 수 있는 질문이 없습니다.</p>

      <details v-if="pack.archived.length" class="interview-archived">
        <summary>보관된 메모 {{ pack.archived.length }}개 <span class="muted small">(지금 이 사례에서 만들어지지 않는 질문, 공개되지 않음)</span></summary>
        <ul class="plain">
          <li v-for="a in pack.archived" :key="a.key">
            <p class="small"><strong>{{ a.text }}</strong></p>
            <p v-if="a.note" class="small pre">{{ a.note }}</p>
            <p class="actions"><button type="button" class="danger" :disabled="busy === a.key" @click="dropArchived(a.key)">지우기</button></p>
          </li>
        </ul>
      </details>
      <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>
    </template>
  </section>
</template>
