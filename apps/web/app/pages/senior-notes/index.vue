<script setup lang="ts">
/**
 * 내 선배 노트(T-13, PROOFU_EVOLUTION_PLAN §8.3). `?course=<과목 id>`로 오면 그 과목에 새 노트를 쓸 수 있습니다.
 * 노트는 초안으로 저장되고, 공개 전 점검 경고를 확인한 뒤 게시합니다. 게시·철회는 작성자만, 철회는 즉시 공개에서 사라집니다.
 */
import type { PublicCourseHubDto, SeniorNoteDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const courseId = computed(() => (typeof route.query.course === 'string' ? route.query.course : ''))

const { data: course } = await useAsyncData(
  () => `senior-note-course:${courseId.value}`,
  () => (courseId.value ? $fetch<PublicCourseHubDto>(`/api/v1/public/courses/${encodeURIComponent(courseId.value)}`).catch(() => null) : Promise.resolve(null)),
  { watch: [courseId] },
)
const { data: notes, refresh } = await useAsyncData(
  () => `my-senior-notes:${courseId.value}`,
  () => useRequestFetch()<SeniorNoteDto[]>('/api/v1/me/senior-notes', { query: { course: courseId.value || undefined } }),
  { watch: [courseId] },
)

useHead({ title: '선배 노트 — Peerchive' })

const editingId = ref<string | null>(null)
const confirmFor = ref<string | null>(null)
const busy = ref<string | null>(null)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function onSaved(note: SeniorNoteDto) {
  editingId.value = null
  message.value = { kind: 'ok', text: note.status === 'draft' ? '초안을 저장했습니다. 내용을 확인한 뒤 게시하세요.' : '저장했습니다.' }
  await refresh()
}

async function publish(note: SeniorNoteDto, confirmWarnings: boolean) {
  busy.value = note.id
  message.value = null
  try {
    await $fetch(`/api/v1/senior-notes/${note.id}/publish`, { method: 'POST', body: { expectedVersion: note.version, confirmWarnings } })
    confirmFor.value = null
    message.value = { kind: 'ok', text: '게시했습니다. 과목 페이지에서 볼 수 있습니다.' }
    await refresh()
  } catch (error) {
    const e = apiError(error)
    if (e.code === 'checks_unconfirmed') confirmFor.value = note.id
    else message.value = { kind: 'error', text: courseHubErrorMessage(e.code) }
  } finally {
    busy.value = null
  }
}

async function withdraw(note: SeniorNoteDto) {
  if (!window.confirm('이 노트를 공개에서 내릴까요? 바로 사라집니다. 이미 다른 사람이 복사한 내용은 회수할 수 없습니다.')) return
  busy.value = note.id
  message.value = null
  try {
    await $fetch(`/api/v1/senior-notes/${note.id}/withdraw`, { method: 'POST' })
    message.value = { kind: 'ok', text: '철회했습니다. 과목 페이지에서 바로 사라집니다.' }
    await refresh()
  } catch (error) {
    message.value = { kind: 'error', text: courseHubErrorMessage(apiError(error).code) }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <h1>선배 노트</h1>
    <p class="hint">과목을 마친 학생이 후배에게 남기는 짧은 회고입니다. 공개 사례가 없어도 쓸 수 있습니다.</p>

    <section v-if="courseId" aria-labelledby="new-note">
      <template v-if="course">
        <h2 id="new-note">새 노트: {{ course.course.school.name }} · {{ course.course.title }} <span class="badge">학생 작성</span></h2>
        <SeniorNoteForm :course-id="course.course.id" @saved="onSaved" />
        <p class="small"><NuxtLink :to="`/c/${course.course.id}`">과목 페이지로 돌아가기</NuxtLink></p>
      </template>
      <p v-else class="notice error">과목을 찾을 수 없습니다.</p>
    </section>

    <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>

    <section aria-labelledby="my-notes">
      <h2 id="my-notes">내가 쓴 노트</h2>
      <ul v-if="notes?.length" class="plain hub-list">
        <li v-for="note in notes" :key="note.id" class="hub-card">
          <p class="small muted">
            <span class="badge">{{ SENIOR_NOTE_STATUS_LABELS[note.status] }}</span>
            · {{ note.course.schoolName }} · <NuxtLink :to="`/c/${note.course.id}`">{{ note.course.title }}</NuxtLink>
            · 표시: {{ note.publicLabel }}
          </p>
          <ModerationNotice v-if="note.moderation" :notice="note.moderation" :id-prefix="`note-${note.id}`" @appealed="refresh()" />
          <SeniorNoteForm v-if="editingId === note.id" :note="note" @saved="onSaved" @cancel="editingId = null" />
          <template v-else>
            <dl class="note-answers">
              <template v-for="q in SENIOR_NOTE_QUESTIONS" :key="q">
                <template v-if="note.answers[q]">
                  <dt>{{ SENIOR_NOTE_QUESTION_LABELS[q] }}</dt>
                  <dd class="pre">{{ note.answers[q] }}</dd>
                </template>
              </template>
            </dl>
            <div v-if="note.warnings.length && note.status !== 'published'" class="notice" role="note">
              <p><strong>공개 전 점검</strong>: 다음 내용이 공개되어도 괜찮은지 확인하세요.</p>
              <ul class="small">
                <li v-for="(w, i) in note.warnings" :key="i">
                  {{ CHECK_RULE_LABELS[w.rule] }} — {{ w.location.field.startsWith('answers.') ? SENIOR_NOTE_QUESTION_LABELS[w.location.field.slice(8) as (typeof SENIOR_NOTE_QUESTIONS)[number]] : w.location.field === 'displayName' ? '표시명' : '학기' }}: <span class="mono">{{ w.sample }}</span>
                </li>
              </ul>
            </div>
            <p class="actions">
              <template v-if="note.status === 'draft' || note.status === 'withdrawn'">
                <button v-if="confirmFor === note.id" type="button" :disabled="busy === note.id" @click="publish(note, true)">경고를 확인했고 게시</button>
                <button v-else type="button" :disabled="busy === note.id" @click="publish(note, false)">게시</button>
              </template>
              <button v-if="note.status === 'published'" type="button" class="danger" :disabled="busy === note.id" @click="withdraw(note)">철회</button>
              <button v-if="note.status !== 'hidden'" type="button" class="secondary" @click="editingId = note.id">고치기</button>
            </p>
            <p v-if="confirmFor === note.id" class="notice" role="alert">{{ courseHubErrorMessage('checks_unconfirmed') }}</p>
          </template>
        </li>
      </ul>
      <p v-else class="muted">아직 쓴 노트가 없습니다. 과목 페이지에서 "선배 노트 쓰기"를 누르세요.</p>
    </section>
  </div>
</template>
