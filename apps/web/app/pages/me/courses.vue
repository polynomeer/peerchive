<script setup lang="ts">
/**
 * 이번 학기 과목 등록·관리(E-01, PROOFU_EVOLUTION_PLAN §8.7, ADR 0046).
 * - 학교 검색 → 과목 검색 → 학기(지금 학기·다음 학기) → 등록. 카탈로그에 있는 과목만 고릅니다(크롤링·계정 연동 없음).
 *   찾는 과목이 없으면 과제 만들기 화면의 과목 고르기에서 먼저 추가합니다.
 * - 등록한 과목은 나만 봅니다. 공개 프로필·검색·피드에는 나오지 않습니다. 지우면 바로 사라집니다.
 */
import type { CourseDto, CourseRegistrationDto, MyCourseRegistrationsDto, SchoolDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '내 과목 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data, error, refresh } = await useFetch<MyCourseRegistrationsDto>('/api/v1/me/course-registrations')

const schoolQ = ref('')
const courseQ = ref('')
const schools = ref<SchoolDto[]>([])
const coursesFound = ref<CourseDto[]>([])
const school = ref<SchoolDto | null>(null)
const course = ref<CourseDto | null>(null)
const termKey = ref('')
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const searched = reactive({ school: false, course: false })

watch(
  data,
  (value) => {
    if (!termKey.value && value?.registrableTerms[0]) termKey.value = `${value.registrableTerms[0].year}:${value.registrableTerms[0].semester}`
  },
  { immediate: true },
)

let timer: ReturnType<typeof setTimeout> | undefined
function schedule(step: 'school' | 'course') {
  clearTimeout(timer)
  timer = setTimeout(() => void search(step), 250)
}
async function search(step: 'school' | 'course') {
  try {
    if (step === 'school') {
      schools.value = schoolQ.value.trim() ? await $fetch<SchoolDto[]>('/api/v1/schools', { query: { q: schoolQ.value } }) : []
      searched.school = true
    } else if (school.value) {
      coursesFound.value = await $fetch<CourseDto[]>(`/api/v1/schools/${school.value.id}/courses`, { query: { q: courseQ.value } })
      searched.course = true
    }
  } catch {
    message.value = { kind: 'error', text: '검색하지 못했습니다. 다시 시도하세요.' }
  }
}
function chooseSchool(s: SchoolDto) {
  school.value = s
  course.value = null
  courseQ.value = ''
  void search('course')
}
function reset() {
  school.value = null
  course.value = null
  schools.value = []
  coursesFound.value = []
  schoolQ.value = ''
  searched.school = false
  searched.course = false
}

const ERRORS: Record<string, string> = {
  already_registered: '이미 등록한 과목입니다.',
  limit_reached: '한 학기에 등록할 수 있는 과목 수를 넘었습니다.',
  rate_limited: '짧은 시간에 너무 많이 시도했습니다. 잠시 뒤 다시 시도하세요.',
}

async function register() {
  if (!course.value || !termKey.value) return
  const [year, semester] = termKey.value.split(':')
  busy.value = true
  message.value = null
  try {
    const created = await $fetch<CourseRegistrationDto>('/api/v1/me/course-registrations', {
      method: 'POST',
      body: { courseId: course.value.id, year: Number(year), semester },
    })
    message.value = { kind: 'ok', text: `${created.course.title}(${created.termLabel})을 등록했습니다.` }
    reset()
    await refresh()
  } catch (e) {
    const err = apiError(e)
    message.value = { kind: 'error', text: ERRORS[err.code] ?? (err.status === 422 ? '등록할 수 없는 과목이나 학기입니다.' : '등록하지 못했습니다. 다시 시도하세요.') }
  } finally {
    busy.value = false
  }
}

async function remove(r: CourseRegistrationDto) {
  if (!confirm(`${r.course.title}(${r.termLabel}) 등록을 지울까요?`)) return
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/me/course-registrations/${r.id}`, { method: 'DELETE' })
    message.value = { kind: 'ok', text: '등록을 지웠습니다.' }
    await refresh()
  } catch {
    message.value = { kind: 'error', text: '지우지 못했습니다. 다시 시도하세요.' }
  } finally {
    busy.value = false
  }
}

const PHASE_LABELS = { current: '이번 학기', upcoming: '다음 학기', ended: '끝난 학기' } as const
</script>

<template>
  <div>
    <h1>내 과목</h1>
    <p class="hint">
      이번 학기 수강 과목을 직접 골라 등록하세요. 다른 서비스의 시간표를 가져오지 않습니다. 등록한 과목은 <strong>나만 봅니다</strong> —
      공개 프로필·검색·피드에 나오지 않고, 과목 허브에는 5명 이상일 때만 익명 인원수로 셉니다.
    </p>
    <p v-if="message" :class="['notice', message.kind === 'error' ? 'error' : '']" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>

    <section class="card" aria-labelledby="register-heading">
      <h2 id="register-heading">과목 등록</h2>
      <p v-if="school" class="actions">
        <span>
          <strong>{{ school.name }}</strong>
          <template v-if="course"> › <strong>{{ course.title }}</strong><span v-if="course.code" class="muted"> ({{ course.code }})</span></template>
          <span class="badge student">학생 작성</span>
        </span>
        <button type="button" class="link-button" @click="reset">다른 학교 고르기</button>
      </p>

      <div v-if="!school" class="stack">
        <div class="field">
          <label for="reg-school-q">학교 검색</label>
          <input id="reg-school-q" v-model="schoolQ" type="search" autocomplete="off" placeholder="예: 한빛대" @input="schedule('school')" @keydown.enter.prevent="search('school')" />
        </div>
        <p class="visually-hidden" role="status">{{ searched.school ? `학교 ${schools.length}개` : '' }}</p>
        <ul v-if="schools.length" class="plain">
          <li v-for="s in schools" :key="s.id"><button type="button" class="secondary" @click="chooseSchool(s)">{{ s.name }}</button></li>
        </ul>
        <p v-else-if="searched.school && schoolQ.trim()" class="muted">찾는 학교가 없습니다.</p>
      </div>

      <div v-else-if="!course" class="stack">
        <div class="field">
          <label for="reg-course-q">과목 검색</label>
          <input id="reg-course-q" v-model="courseQ" type="search" autocomplete="off" placeholder="과목 이름 또는 코드" @input="schedule('course')" @keydown.enter.prevent="search('course')" />
        </div>
        <p class="visually-hidden" role="status">{{ searched.course ? `과목 ${coursesFound.length}개` : '' }}</p>
        <ul v-if="coursesFound.length" class="plain">
          <li v-for="c in coursesFound" :key="c.id">
            <button type="button" class="secondary" @click="course = c">{{ c.title }}<template v-if="c.code"> ({{ c.code }})</template></button>
          </li>
        </ul>
        <p v-else-if="searched.course" class="muted">찾는 과목이 없습니다.</p>
        <p class="hint">목록에 없는 과목은 <NuxtLink to="/projects">새 과제 만들기</NuxtLink>의 과목 고르기에서 먼저 추가할 수 있습니다.</p>
      </div>

      <form v-else class="stack" novalidate @submit.prevent="register">
        <div class="field">
          <label for="reg-term">학기</label>
          <select id="reg-term" v-model="termKey">
            <option v-for="t in data?.registrableTerms ?? []" :key="`${t.year}:${t.semester}`" :value="`${t.year}:${t.semester}`">
              {{ t.label }}{{ t.current ? ' (지금 학기)' : ' (다음 학기)' }}
            </option>
          </select>
        </div>
        <div class="actions">
          <button type="submit" :disabled="busy">{{ busy ? '등록하는 중…' : '등록하기' }}</button>
        </div>
      </form>
    </section>

    <section class="card" aria-labelledby="registered-heading">
      <h2 id="registered-heading">등록한 과목</h2>
      <p v-if="error" class="notice error" role="alert">목록을 불러오지 못했습니다.</p>
      <p v-else-if="!data?.items.length" class="muted">아직 등록한 과목이 없습니다.</p>
      <ul v-else class="plain" aria-label="등록한 과목 목록">
        <li v-for="r in data.items" :key="r.id" class="row">
          <span>
            <NuxtLink :to="`/c/${r.course.id}`">{{ r.course.title }}</NuxtLink>
            <span class="muted"> · {{ r.school.name }} · {{ r.termLabel }}</span>
            <span class="badge">{{ PHASE_LABELS[r.phase] }}</span>
          </span>
          <button type="button" class="link-button" :disabled="busy" @click="remove(r)">지우기</button>
        </li>
      </ul>
      <p><NuxtLink to="/">홈에서 과목별 바로 가기 보기</NuxtLink></p>
    </section>
  </div>
</template>
