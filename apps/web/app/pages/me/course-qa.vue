<script setup lang="ts">
/**
 * 내 막힘 Q&A(C-09, ADR 0025). 내가 질문했거나 답한 막힘 Q&A와 상태를 보고 언제든 공개를 철회합니다(즉시 사라짐). 상대가 누구인지는 없습니다.
 */
import type { MyCourseQaDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '내 막힘 Q&A — Peerchive' })

const { data: items, refresh } = await useAsyncData('my-course-qa', () => useRequestFetch()<MyCourseQaDto[]>('/api/v1/me/course-qa'))
const busy = ref<string | null>(null)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const STATUS: Record<MyCourseQaDto['status'], string> = { published: '공개 중', withdrawn: '철회됨', hidden: '운영 조치로 숨겨짐' }

async function withdraw(qa: MyCourseQaDto) {
  if (!window.confirm('이 막힘 Q&A를 공개에서 내릴까요? 과목 페이지와 검색에서 바로 사라집니다.')) return
  busy.value = qa.id
  try {
    await $fetch(`/api/v1/course-qa/${qa.id}/withdraw`, { method: 'POST' })
    message.value = { kind: 'ok', text: '공개를 철회했습니다.' }
    await refresh()
  } catch (e) {
    message.value = { kind: 'error', text: courseHubErrorMessage(apiError(e).code) }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <h1>내 막힘 Q&amp;A</h1>
    <p class="hint">커뮤니티에서 옮긴 질문·답변입니다. 질문한 학생과 답한 학생 누구나 언제든 공개를 철회할 수 있습니다.</p>
    <p v-if="message" :class="['notice', message.kind]" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>
    <ul v-if="items?.length" class="plain hub-list">
      <li v-for="qa in items" :key="qa.id" class="hub-card">
        <p class="hub-card-title">{{ qa.questionTitle || '(철회되어 내용을 지웠습니다)' }}</p>
        <p class="small muted">
          {{ qa.course.schoolName }} {{ qa.course.title }} · {{ qa.role === 'asker' ? '내가 질문함' : '내가 답함' }} · 내 이름 표시 "{{ qa.myLabel }}" ·
          {{ STATUS[qa.status] }}
        </p>
        <p class="actions small">
          <NuxtLink v-if="qa.path" :to="qa.path">과목 페이지에서 보기</NuxtLink>
          <button v-if="qa.status !== 'withdrawn'" type="button" class="secondary small" :disabled="busy === qa.id" @click="withdraw(qa)">공개 철회</button>
        </p>
      </li>
    </ul>
    <p v-else class="muted">아직 막힘 Q&amp;A가 없습니다.</p>
  </div>
</template>
