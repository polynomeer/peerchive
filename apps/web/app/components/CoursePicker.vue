<script setup lang="ts">
/**
 * 과목 고르기(T-10): 학교 검색 → 과목 검색 → 개설 학기 고르기/추가.
 * - 학교·과목·학기는 학생이 입력한 값입니다("학생 작성"). 교수 이름·평가는 받지 않습니다.
 * - 새로 만들 때 비슷한 이름이 있으면 서버가 409로 후보를 주고, 고르거나 "그래도 새로 만들기"를 눌러야 합니다.
 * - 학기 종료일은 서버가 학기에서 계산하며 직접 정할 수 없습니다(엠바고 기준).
 * v-model은 개설 학기 id(없으면 null)입니다. 다른 폼 안에 들어가므로 자체 form 없이 버튼·Enter 키로 동작합니다.
 */
import type {
  CatalogCandidateDto,
  CourseDto,
  CourseTermDto,
  CourseTermResultDto,
  SchoolDto,
  Semester,
} from '~~/shared/types/api'

const props = defineProps<{
  modelValue: string | null
  /** 지금 연결된 과목 정보(수정 화면). */
  initial?: { school: SchoolDto; course: CourseDto; term: CourseTermDto } | null
  idPrefix: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()

const school = ref<SchoolDto | null>(props.initial?.school ?? null)
const course = ref<CourseDto | null>(props.initial?.course ?? null)
const term = ref<CourseTermDto | null>(props.initial?.term ?? null)

// ── 공통: 검색 + 비슷한 항목 확인 ──
type Step = 'school' | 'course'
const queries = reactive<Record<Step, string>>({ school: '', course: '' })
const results = reactive<{ school: SchoolDto[]; course: CourseDto[] }>({ school: [], course: [] })
const searched = reactive<Record<Step, boolean>>({ school: false, course: false })
const conflict = ref<{ step: Step; code: string; candidates: CatalogCandidateDto[] } | null>(null)
const failure = ref<string | null>(null)
const busy = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined
function scheduleSearch(step: Step) {
  clearTimeout(timer)
  timer = setTimeout(() => void search(step), 250)
}

async function search(step: Step) {
  failure.value = null
  try {
    if (step === 'school') {
      results.school = queries.school.trim()
        ? await $fetch<SchoolDto[]>('/api/v1/schools', { query: { q: queries.school } })
        : []
    } else if (school.value) {
      results.course = await $fetch<CourseDto[]>(`/api/v1/schools/${school.value.id}/courses`, { query: { q: queries.course } })
    }
    searched[step] = true
  } catch {
    failure.value = '검색하지 못했습니다. 다시 시도하세요.'
  }
}

function catalogError(step: Step, e: unknown) {
  const err = apiError(e)
  const data = (e as { data?: { data?: { candidates?: CatalogCandidateDto[] } } })?.data?.data
  if (err.status === 409 && data?.candidates) {
    conflict.value = { step, code: err.code, candidates: data.candidates }
  } else if (err.status === 429) {
    failure.value = CATALOG_CONFLICT_MESSAGES.rate_limited ?? null
  } else if (err.status === 422) {
    failure.value = fieldMessage(Object.values(err.fields)[0]) ?? '입력을 확인하세요.'
  } else {
    failure.value = '만들지 못했습니다. 다시 시도하세요.'
  }
}

// ── 1. 학교 ──
const newSchool = ref('')
function chooseSchool(value: SchoolDto) {
  school.value = value
  course.value = null
  term.value = null
  conflict.value = null
  emit('update:modelValue', null)
  queries.course = ''
  void search('course')
}
async function createSchool(confirmNew = false) {
  busy.value = true
  failure.value = null
  conflict.value = null
  try {
    chooseSchool(await $fetch<SchoolDto>('/api/v1/schools', { method: 'POST', body: { name: newSchool.value, confirmNew } }))
    newSchool.value = ''
  } catch (e) {
    catalogError('school', e)
  } finally {
    busy.value = false
  }
}

// ── 2. 과목 ──
const newCourse = reactive({ title: '', code: '' })
function chooseCourse(value: CourseDto) {
  course.value = value
  term.value = null
  conflict.value = null
  emit('update:modelValue', null)
  void loadTerms()
}
async function createCourse(confirmNew = false) {
  if (!school.value) return
  busy.value = true
  failure.value = null
  conflict.value = null
  try {
    const created = await $fetch<CourseDto>(`/api/v1/schools/${school.value.id}/courses`, {
      method: 'POST',
      body: { title: newCourse.title, code: newCourse.code || null, confirmNew },
    })
    newCourse.title = ''
    newCourse.code = ''
    chooseCourse(created)
  } catch (e) {
    catalogError('course', e)
  } finally {
    busy.value = false
  }
}
function chooseCandidate(step: Step, candidate: CatalogCandidateDto) {
  if (step === 'school') chooseSchool({ id: candidate.id, name: candidate.name })
  else if (school.value) chooseCourse({ id: candidate.id, schoolId: school.value.id, title: candidate.name, code: candidate.code ?? null })
}

// ── 3. 개설 학기 ──
const terms = ref<CourseTermDto[]>([])
const thisYear = new Date().getFullYear()
const newTerm = reactive<{ year: number; semester: Semester }>({ year: thisYear, semester: new Date().getMonth() < 7 ? 'spring' : 'fall' })
async function loadTerms() {
  if (!course.value) return
  try {
    terms.value = await $fetch<CourseTermDto[]>(`/api/v1/courses/${course.value.id}/terms`)
  } catch {
    failure.value = '학기 목록을 불러오지 못했습니다.'
  }
}
function chooseTerm(value: CourseTermDto | null) {
  term.value = value
  emit('update:modelValue', value?.id ?? null)
}
function onTermSelect(id: string) {
  chooseTerm(terms.value.find((t) => t.id === id) ?? null)
}
async function addTerm() {
  if (!course.value) return
  busy.value = true
  failure.value = null
  try {
    const res = await $fetch<CourseTermResultDto>(`/api/v1/courses/${course.value.id}/terms`, {
      method: 'POST',
      body: { year: Number(newTerm.year), semester: newTerm.semester },
    })
    await loadTerms()
    chooseTerm(res.term)
  } catch (e) {
    catalogError('course', e)
  } finally {
    busy.value = false
  }
}

function reset() {
  school.value = null
  course.value = null
  term.value = null
  conflict.value = null
  results.school = []
  results.course = []
  queries.school = ''
  emit('update:modelValue', null)
}

onMounted(() => {
  if (course.value) void loadTerms()
})

const id = (suffix: string) => `${props.idPrefix}-${suffix}`
</script>

<template>
  <fieldset class="course-picker">
    <legend>과목(선택)</legend>
    <p class="hint">
      학교·과목·학기를 연결하면 그 학기가 끝날 때까지 이 과제를 공개할 수 없습니다(엠바고). 이름은 학생이 입력한 값입니다.
    </p>

    <p v-if="school" class="actions">
      <span>
        <strong>{{ school.name }}</strong>
        <template v-if="course"> › <strong>{{ course.title }}</strong><span v-if="course.code" class="muted"> ({{ course.code }})</span></template>
        <template v-if="term"> › <strong>{{ termLabel(term) }}</strong></template>
        <span class="badge student">학생 작성</span>
      </span>
      <button type="button" class="link-button" @click="reset">다른 학교 고르기 / 연결 안 함</button>
    </p>

    <p v-if="failure" class="field-error" role="alert">{{ failure }}</p>

    <div v-if="conflict" class="notice" role="alert">
      <p>{{ CATALOG_CONFLICT_MESSAGES[conflict.code] ?? '이미 있는 항목이 있습니다.' }}</p>
      <ul class="plain">
        <li v-for="c in conflict.candidates" :key="c.id">
          <button type="button" class="secondary" @click="chooseCandidate(conflict.step, c)">
            {{ c.name }}<template v-if="c.code"> ({{ c.code }})</template> 고르기
          </button>
        </li>
      </ul>
      <div class="actions">
        <button
          v-if="conflict.code === 'similar_exists'"
          type="button"
          :disabled="busy"
          @click="conflict.step === 'school' ? createSchool(true) : createCourse(true)"
        >
          그래도 새로 만들기
        </button>
        <button type="button" class="secondary" @click="conflict = null">닫기</button>
      </div>
    </div>

    <!-- 1. 학교 -->
    <div v-if="!school" class="stack">
      <div class="field">
        <label :for="id('school-q')">학교 검색</label>
        <input
          :id="id('school-q')"
          v-model="queries.school"
          type="search"
          autocomplete="off"
          placeholder="예: 한빛대"
          @input="scheduleSearch('school')"
          @keydown.enter.prevent="search('school')"
        />
      </div>
      <p class="visually-hidden" role="status">{{ searched.school ? `학교 ${results.school.length}개` : '' }}</p>
      <ul v-if="results.school.length > 0" class="plain">
        <li v-for="s in results.school" :key="s.id">
          <button type="button" class="secondary" @click="chooseSchool(s)">{{ s.name }}</button>
        </li>
      </ul>
      <div v-if="searched.school && queries.school.trim()" class="actions">
        <label :for="id('school-new')">찾는 학교가 없으면 추가</label>
        <input :id="id('school-new')" v-model="newSchool" maxlength="80" placeholder="학교 이름" @keydown.enter.prevent="createSchool()" />
        <button type="button" class="secondary" :disabled="busy || !newSchool.trim()" @click="createSchool()">학교 추가</button>
      </div>
    </div>

    <!-- 2. 과목 -->
    <div v-else-if="!course" class="stack">
      <div class="field">
        <label :for="id('course-q')">과목 검색</label>
        <input
          :id="id('course-q')"
          v-model="queries.course"
          type="search"
          autocomplete="off"
          placeholder="과목 이름 또는 코드"
          @input="scheduleSearch('course')"
          @keydown.enter.prevent="search('course')"
        />
      </div>
      <p class="visually-hidden" role="status">{{ searched.course ? `과목 ${results.course.length}개` : '' }}</p>
      <ul v-if="results.course.length > 0" class="plain">
        <li v-for="c in results.course" :key="c.id">
          <button type="button" class="secondary" @click="chooseCourse(c)">
            {{ c.title }}<template v-if="c.code"> ({{ c.code }})</template>
          </button>
        </li>
      </ul>
      <p v-else-if="searched.course" class="muted">찾는 과목이 없습니다.</p>
      <div class="stack">
        <p class="hint">찾는 과목이 없으면 추가하세요. 교수 이름은 적지 않습니다.</p>
        <div class="actions">
          <label :for="id('course-title')">과목 이름</label>
          <input :id="id('course-title')" v-model="newCourse.title" maxlength="100" @keydown.enter.prevent="createCourse()" />
          <label :for="id('course-code')">과목 코드(선택)</label>
          <input :id="id('course-code')" v-model="newCourse.code" maxlength="30" @keydown.enter.prevent="createCourse()" />
          <button type="button" class="secondary" :disabled="busy || !newCourse.title.trim()" @click="createCourse()">과목 추가</button>
        </div>
      </div>
    </div>

    <!-- 3. 개설 학기 -->
    <div v-else class="stack">
      <div class="field">
        <label :for="id('term')">개설 학기</label>
        <select :id="id('term')" :value="term?.id ?? ''" @change="onTermSelect(($event.target as HTMLSelectElement).value)">
          <option value="">선택하세요</option>
          <option v-for="t in terms" :key="t.id" :value="t.id">{{ termLabel(t) }} · 종료 {{ seoulDay(t.endsAt) }}</option>
        </select>
      </div>
      <div class="actions">
        <span class="muted">목록에 없으면</span>
        <label :for="id('term-year')">연도</label>
        <input :id="id('term-year')" v-model.number="newTerm.year" @keydown.enter.prevent="addTerm" type="number" :min="thisYear - 30" :max="thisYear + 1" class="year" />
        <label :for="id('term-semester')">학기</label>
        <select :id="id('term-semester')" v-model="newTerm.semester">
          <option v-for="s in SEMESTER_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
        <button type="button" class="secondary" :disabled="busy" @click="addTerm">학기 추가</button>
      </div>
      <p class="hint">학기 종료일은 학기에 따라 자동으로 정해집니다(1학기 6/30, 여름 8/31, 2학기 12/31, 겨울 다음 해 2월 말).</p>
      <p v-if="term" class="hint" role="status">학기 종료 {{ seoulDay(term.endsAt) }}까지 공개할 수 없습니다.</p>
    </div>
  </fieldset>
</template>
