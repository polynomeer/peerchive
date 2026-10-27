<script setup lang="ts">
/**
 * "아카이브로 옮기기" 폼(C-09, ADR 0025). 원 글의 글쓴이에게만 보입니다.
 * - 옮길 곳: 막힘 Q&A(질문 + 채택된 답변, 답한 학생의 동의 필요) / 내 과제의 막힘 로그(비공개) / 선배 노트 초안(내 글).
 * - 복사본에 보일 이름을 다시 고릅니다. 원 글은 그대로 남고 열람 범위도 바뀌지 않습니다.
 * - 막힘 Q&A는 공개 전 점검 경고를 보여 주고 확인을 받습니다(답한 학생에게도 같은 경고가 보임).
 * 성공하면 요청 화면(/community/archive-transfers/:id)으로 갑니다.
 */
import type { ArchiveOptionsDto, ArchiveTransferDto, ArchiveTransferTarget, CourseDto, PublicationCheckRule, SchoolDto } from '~~/shared/types/api'

const props = defineProps<{ postId: string }>()
const emit = defineEmits<{ close: [] }>()

const options = ref<ArchiveOptionsDto | null>(null)
const loadError = ref('')
onMounted(async () => {
  try {
    options.value = await $fetch<ArchiveOptionsDto>(`/api/v1/community/posts/${props.postId}/archive-options`)
    const first = (['course_qa', 'stuck_log', 'senior_note'] as const).find((t) => options.value!.targets[t] === null)
    if (first) form.target = first
    if (options.value.school) school.value = { id: options.value.school.id, name: options.value.school.name } as SchoolDto
  } catch (e) {
    loadError.value = communityErrorMessage(apiError(e).code)
  }
})

const REASON_TEXT: Record<string, string> = {
  source_not_open: '지워졌거나 가려진 글은 옮길 수 없습니다.',
  not_author: '내가 쓴 글만 옮길 수 있습니다.',
  not_question_board: '질문 게시판의 글만 옮길 수 있습니다.',
  no_accepted_answer: '먼저 답변 하나를 채택하세요.',
}

const form = reactive({
  target: 'course_qa' as ArchiveTransferTarget,
  qaDisplay: 'anonymous' as 'anonymous' | 'display' | 'real',
  projectId: '',
  timeBucket: 'lt2h',
  includeAnswer: false,
  notAnswerConfirmed: false,
  answerKey: 'wishKnew' as (typeof SENIOR_NOTE_QUESTIONS)[number],
  noteDisplay: 'anonymous' as 'name' | 'display' | 'anonymous',
  noteDisplayName: '',
  noAnswersConfirmed: false,
  confirmWarnings: false,
})

// ── 과목 고르기(원 글 공간의 학교 과목, 학교 없는 방은 학교부터) ──
const school = ref<SchoolDto | null>(null)
const course = ref<CourseDto | null>(null)
const schoolQuery = ref('')
const courseQuery = ref('')
const schoolResults = ref<SchoolDto[]>([])
const courseResults = ref<CourseDto[]>([])
async function searchSchools() {
  schoolResults.value = await $fetch<SchoolDto[]>('/api/v1/schools', { query: { q: schoolQuery.value } }).catch(() => [])
}
async function searchCourses() {
  if (!school.value) return
  courseResults.value = await $fetch<CourseDto[]>(`/api/v1/schools/${school.value.id}/courses`, { query: { q: courseQuery.value } }).catch(() => [])
}
const needsCourse = computed(() => form.target === 'course_qa' || form.target === 'senior_note')

const TIME_LABELS: Record<string, string> = { lt30m: '30분 미만', lt2h: '2시간 미만', half_day: '반나절', day_plus: '하루 이상' }

const warnings = ref<Array<{ rule: PublicationCheckRule; field: string; sample: string }>>([])
const errors = ref<string[]>([])
const busy = ref(false)

const tooLong = computed(() => {
  const o = options.value
  if (!o) return false
  if (form.target === 'stuck_log') return o.lengths.title > o.limits.stuckSymptom || o.lengths.body > o.limits.logBody || (form.includeAnswer && o.lengths.answer > o.limits.solution)
  if (form.target === 'senior_note') return o.lengths.body > o.limits.noteAnswer
  return false
})

const FIELD_LABELS: Record<string, string> = { questionTitle: '질문 제목', questionBody: '질문 본문', answerBody: '답변' }

async function submit() {
  errors.value = []
  busy.value = true
  const body: Record<string, unknown> = { target: form.target }
  if (needsCourse.value && course.value) body.courseId = course.value.id
  if (form.target === 'course_qa') {
    body.displayMode = form.qaDisplay
    if (warnings.value.length) body.confirmWarnings = form.confirmWarnings
  } else if (form.target === 'stuck_log') {
    if (form.projectId) body.projectId = form.projectId
    body.timeBucket = form.timeBucket
    body.includeAnswer = form.includeAnswer
    if (form.includeAnswer) body.notAnswerConfirmed = form.notAnswerConfirmed
  } else {
    body.answerKey = form.answerKey
    body.displayMode = form.noteDisplay
    if (form.noteDisplay === 'display') body.displayName = form.noteDisplayName
    body.noAnswersConfirmed = form.noAnswersConfirmed
  }
  try {
    const created = await $fetch<ArchiveTransferDto>(`/api/v1/community/posts/${props.postId}/archive-transfers`, { method: 'POST', body })
    await navigateTo(`/community/archive-transfers/${created.id}`)
  } catch (e) {
    const err = apiError(e)
    if (err.code === 'checks_unconfirmed') {
      warnings.value = ((err.data as unknown as { warnings?: typeof warnings.value }).warnings ?? []) as typeof warnings.value
      errors.value = [communityErrorMessage(err.code)]
    } else if (err.code === 'validation_failed') errors.value = archiveFieldErrors(err.fields)
    else errors.value = [communityErrorMessage(err.code)]
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="archive-form stack" aria-labelledby="archive-form-title" data-testid="archive-form">
    <h2 id="archive-form-title">아카이브로 옮기기</h2>
    <p class="hint">
      이 글(과 채택된 답변)을 복사해 아카이브에 남깁니다. 원 글은 커뮤니티에 그대로 남고 볼 수 있는 사람도 바뀌지 않습니다. 답변을 옮길 때는 답한 학생이 옮겨질 글을 보고 동의해야
      복사됩니다(14일 안에 동의가 없으면 만료). 답한 학생이 누구인지는 동의 과정에서 알려 드리지 않습니다.
    </p>
    <p v-if="loadError" class="notice error" role="alert">{{ loadError }}</p>
    <form v-else-if="options" class="stack" novalidate @submit.prevent="submit">
      <fieldset>
        <legend>옮길 곳</legend>
        <div v-for="t in (['course_qa', 'stuck_log', 'senior_note'] as const)" :key="t" class="radio-row">
          <input :id="`archive-target-${t}`" v-model="form.target" type="radio" name="archive-target" :value="t" :disabled="options.targets[t] !== null" />
          <label :for="`archive-target-${t}`">
            {{ ARCHIVE_TARGET_LABELS[t] }}
            <span v-if="options.targets[t]" class="small muted"> — {{ REASON_TEXT[options.targets[t]!] }}</span>
          </label>
        </div>
      </fieldset>

      <fieldset v-if="needsCourse">
        <legend>과목</legend>
        <p v-if="options.school" class="small">학교: {{ options.school.name }} <span class="badge">학생 작성</span></p>
        <template v-else>
          <div class="field">
            <label for="archive-school-q">학교 찾기</label>
            <input id="archive-school-q" v-model="schoolQuery" type="search" maxlength="60" @keydown.enter.prevent="searchSchools" />
            <button type="button" class="secondary small" @click="searchSchools">학교 찾기</button>
          </div>
          <ul v-if="schoolResults.length" class="plain">
            <li v-for="s in schoolResults" :key="s.id">
              <button type="button" class="link-button" @click="(school = s), (course = null), (schoolResults = [])">{{ s.name }}</button>
            </li>
          </ul>
          <p v-if="school" class="small">고른 학교: {{ school.name }}</p>
        </template>
        <template v-if="school">
          <div class="field">
            <label for="archive-course-q">과목 찾기</label>
            <input id="archive-course-q" v-model="courseQuery" type="search" maxlength="80" data-testid="archive-course-q" @keydown.enter.prevent="searchCourses" />
            <button type="button" class="secondary small" data-testid="archive-course-search" @click="searchCourses">과목 찾기</button>
          </div>
          <ul v-if="courseResults.length" class="plain" aria-label="과목 검색 결과">
            <li v-for="c in courseResults" :key="c.id">
              <button type="button" class="link-button" :aria-pressed="course?.id === c.id" @click="(course = c), (courseResults = [])">
                {{ c.title }}<template v-if="c.code"> ({{ c.code }})</template>
              </button>
            </li>
          </ul>
          <p v-if="course" class="small" data-testid="archive-course-chosen">고른 과목: <strong>{{ course.title }}</strong></p>
        </template>
      </fieldset>

      <template v-if="form.target === 'course_qa'">
        <fieldset>
          <legend>막힘 Q&amp;A에 보일 내 이름</legend>
          <div class="radio-row">
            <input id="qa-display-anon" v-model="form.qaDisplay" type="radio" name="qa-display" value="anonymous" />
            <label for="qa-display-anon">익명("{{ COURSE_QA_ANONYMOUS_LABELS.asker }}")</label>
          </div>
          <div class="radio-row">
            <input id="qa-display-display" v-model="form.qaDisplay" type="radio" name="qa-display" value="display" />
            <label for="qa-display-display">표시명({{ options.displayName }})</label>
          </div>
          <div v-if="options.hasRealName" class="radio-row">
            <input id="qa-display-real" v-model="form.qaDisplay" type="radio" name="qa-display" value="real" />
            <label for="qa-display-real">실명</label>
          </div>
          <p class="hint">
            원 글의 이름 표시와 따로 고릅니다. 이름을 고르면 원 글을 읽을 수 있는 사람은 같은 글임을 알아볼 수 있습니다. 답한 학생은 자기 이름을 따로 고릅니다.
          </p>
        </fieldset>
        <div v-if="warnings.length" class="notice" role="status" data-testid="archive-warnings">
          <p><strong>공개 전 점검 경고</strong>(답한 학생에게도 보입니다)</p>
          <ul>
            <li v-for="(w, i) in warnings" :key="i">{{ CHECK_RULE_LABELS[w.rule] ?? w.rule }} · {{ FIELD_LABELS[w.field] ?? w.field }} · {{ w.sample }}</li>
          </ul>
          <div class="radio-row">
            <input id="archive-confirm-warnings" v-model="form.confirmWarnings" type="checkbox" />
            <label for="archive-confirm-warnings">경고를 확인했습니다. 이대로 동의를 요청합니다.</label>
          </div>
        </div>
      </template>

      <template v-else-if="form.target === 'stuck_log'">
        <div class="field">
          <label for="archive-project">과제</label>
          <select id="archive-project" v-model="form.projectId">
            <option value="">과제를 고르세요</option>
            <option v-for="p in options.projects" :key="p.id" :value="p.id">{{ p.title }}</option>
          </select>
          <p v-if="!options.projects.length" class="hint">내가 owner·editor인 과제가 없습니다.</p>
        </div>
        <div class="field">
          <label for="archive-time">막혔던 시간</label>
          <select id="archive-time" v-model="form.timeBucket">
            <option v-for="b in options.timeBuckets" :key="b" :value="b">{{ TIME_LABELS[b] ?? b }}</option>
          </select>
        </div>
        <div v-if="options.hasAcceptedAnswer" class="radio-row">
          <input id="archive-include-answer" v-model="form.includeAnswer" type="checkbox" />
          <label for="archive-include-answer">채택된 답변도 💡 해결 로그로 옮기기{{ options.answerIsMine ? '' : '(답한 학생의 동의 필요)' }}</label>
        </div>
        <div v-if="form.includeAnswer" class="radio-row">
          <input id="archive-not-answer" v-model="form.notAnswerConfirmed" type="checkbox" />
          <label for="archive-not-answer">답변이 과제 답 자체가 아님을 확인했습니다.</label>
        </div>
        <p class="hint">질문 제목은 증상, 본문은 로그 본문이 됩니다. 과제 안에서만 보이고 공개되지 않습니다.</p>
      </template>

      <template v-else>
        <div class="field">
          <label for="archive-answer-key">이 글을 넣을 질문</label>
          <select id="archive-answer-key" v-model="form.answerKey">
            <option v-for="q in SENIOR_NOTE_QUESTIONS" :key="q" :value="q">{{ SENIOR_NOTE_QUESTION_LABELS[q] }}</option>
          </select>
        </div>
        <fieldset>
          <legend>선배 노트 작성자 표시</legend>
          <div v-for="m in (['anonymous', 'display', 'name'] as const)" :key="m" class="radio-row">
            <input :id="`note-display-${m}`" v-model="form.noteDisplay" type="radio" name="note-display" :value="m" />
            <label :for="`note-display-${m}`">{{ SENIOR_NOTE_DISPLAY_LABELS[m] }}</label>
          </div>
          <div v-if="form.noteDisplay === 'display'" class="field">
            <label for="note-display-name">표시명</label>
            <input id="note-display-name" v-model="form.noteDisplayName" maxlength="40" />
          </div>
        </fieldset>
        <div class="radio-row">
          <input id="archive-no-answers" v-model="form.noAnswersConfirmed" type="checkbox" />
          <label for="archive-no-answers">이 글에 과제 정답·답안·교수 개인 평가가 포함되어 있지 않습니다.</label>
        </div>
        <p class="hint">초안으로 만들어집니다. 선배 노트 화면에서 다른 질문의 답을 더하고(2개 이상) 점검을 거쳐 게시하세요.</p>
      </template>

      <p v-if="tooLong" class="notice error" role="status">원 글이 너무 길어 이 곳으로 옮길 수 없습니다.</p>
      <ul v-if="errors.length" class="notice error" role="alert">
        <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
      </ul>
      <p class="actions">
        <button type="submit" :disabled="busy || tooLong" data-testid="archive-submit">{{ form.target === 'senior_note' ? '선배 노트 초안 만들기' : '옮기기 요청' }}</button>
        <button type="button" class="secondary" @click="emit('close')">닫기</button>
      </p>
    </form>
    <p v-else class="muted">불러오는 중…</p>
  </section>
</template>

<style scoped>
.archive-form {
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  padding: 0.75rem;
  overflow-wrap: anywhere;
}
</style>
