<script setup lang="ts">
/**
 * 학생 큐레이터 운영(E-03, ADR 0048). 운영자가 아니면 404로 보입니다(API는 403 operator_only).
 * - 지정·해제: 과목 id와 사용자 id로 지정합니다(자격: 과목을 마침 + 그 학교 active 학교 인증, 과목당 2명). 해제하면 다음 요청부터 권한이 없습니다.
 * - 개념 태그 병합 제안 대기열: 승인하면 기존 태그 병합을 실행하고, 거절하면 상태만 바꿉니다.
 * 신고에 대한 큐레이터 의견은 신고 상세에서 봅니다.
 */
import type { ConceptTagProposalDto, OperatorCourseCuratorDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '학생 큐레이터 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data: curators, error, refresh } = await useFetch<OperatorCourseCuratorDto[]>('/api/v1/operator/curators')
const { data: proposals, refresh: refreshProposals } = await useFetch<ConceptTagProposalDto[]>('/api/v1/operator/concept-tag-proposals', { query: { status: 'pending' } })
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const form = reactive({ courseId: '', userId: '' })
const busy = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const ERRORS: Record<string, string> = {
  not_found: '사용자를 찾을 수 없습니다.',
  inactive: '활성 계정이 아닙니다.',
  not_finished: '이 과목을 마친 기록(끝난 학기 등록 또는 과제 공간)이 없습니다.',
  not_verified: '이 과목 학교의 학교 메일 인증이 없습니다.',
  invalid: '형식이 올바르지 않습니다.',
  already_curator: '이미 이 과목의 큐레이터입니다.',
  limit_reached: '이 과목에는 이미 큐레이터 2명이 있습니다.',
}

async function grant() {
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/operator/courses/${form.courseId.trim()}/curators`, { method: 'POST', body: { userId: form.userId.trim() } })
    message.value = { kind: 'ok', text: '큐레이터로 지정했습니다.' }
    Object.assign(form, { courseId: '', userId: '' })
    await refresh()
  } catch (e) {
    const err = apiError(e)
    const field = Object.values(err.fields ?? {})[0]
    message.value = { kind: 'error', text: (field && ERRORS[field]) || ERRORS[err.code] || (err.status === 404 ? '과목을 찾을 수 없습니다.' : '지정하지 못했습니다.') }
  } finally {
    busy.value = false
  }
}

async function revoke(c: OperatorCourseCuratorDto) {
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/operator/courses/${c.course.id}/curators/${c.userId}`, { method: 'DELETE' })
    message.value = { kind: 'ok', text: '해제했습니다.' }
    await refresh()
  } catch {
    message.value = { kind: 'error', text: '해제하지 못했습니다.' }
  } finally {
    busy.value = false
  }
}

async function decide(p: ConceptTagProposalDto, decision: 'approve' | 'reject') {
  busy.value = true
  message.value = null
  try {
    await $fetch(`/api/v1/operator/concept-tag-proposals/${p.id}/${decision}`, { method: 'POST' })
    message.value = { kind: 'ok', text: decision === 'approve' ? '병합했습니다.' : '거절했습니다.' }
  } catch (e) {
    const err = apiError(e)
    message.value = { kind: 'error', text: err.code === 'already_decided' ? '이미 결정된 제안입니다.' : '병합할 수 없습니다(태그가 이미 병합됐을 수 있습니다). 거절하세요.' }
  } finally {
    busy.value = false
    await refreshProposals()
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
    </template>
    <template v-else>
      <h1>학생 큐레이터</h1>
      <p class="hint">과목마다 그 과목을 마친 고학년·졸업생 1~2명. 큐레이터는 과제 유형 요약·병합 제안·1차 신고 의견·팀원 찾기 끄기만 하고, 처리·가리기·계정 조치·작성자 확인은 운영자가 합니다.</p>
      <p v-if="message" :class="['notice', message.kind === 'error' ? 'error' : 'ok']" role="status">{{ message.text }}</p>

      <section aria-labelledby="op-curator-grant">
        <h2 id="op-curator-grant">지정</h2>
        <form class="stack" @submit.prevent="grant">
          <label>과목 id <input v-model="form.courseId" type="text" required /></label>
          <label>사용자 id <input v-model="form.userId" type="text" required /></label>
          <p class="actions"><button type="submit" :disabled="busy">큐레이터로 지정</button></p>
        </form>
      </section>

      <section aria-labelledby="op-curator-list">
        <h2 id="op-curator-list">지금 큐레이터</h2>
        <ul v-if="curators?.length" class="plain operator-list">
          <li v-for="c in curators" :key="c.id">
            <p>
              <NuxtLink :to="`/curator/${c.course.id}`">{{ c.course.schoolName }} · {{ c.course.title }}</NuxtLink> — {{ c.displayName }}
              <span class="small muted">({{ c.userId }}, {{ formatDateTime(c.grantedAt) }} 지정)</span>
              <button type="button" class="link-button" :disabled="busy" @click="revoke(c)">해제</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 큐레이터가 없습니다.</p>
      </section>

      <section aria-labelledby="op-tag-proposals" data-testid="tag-proposals">
        <h2 id="op-tag-proposals">개념 태그 병합 제안</h2>
        <ul v-if="proposals?.length" class="plain operator-list">
          <li v-for="p in proposals" :key="p.id">
            <p>
              #{{ p.source.label }} → #{{ p.target.label }} · {{ p.course.schoolName }} {{ p.course.title }} · {{ p.proposer?.displayName || '탈퇴한 큐레이터' }}
            </p>
            <p v-if="p.note" class="small">{{ p.note }}</p>
            <p class="actions small">
              <button type="button" :disabled="busy" @click="decide(p, 'approve')">승인(병합)</button>
              <button type="button" class="secondary" :disabled="busy" @click="decide(p, 'reject')">거절</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">검토할 제안이 없습니다.</p>
      </section>
    </template>
  </div>
</template>
