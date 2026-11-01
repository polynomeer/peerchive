<script setup lang="ts">
/**
 * 막힘 카드의 질문 스레드 목록(E-04, ADR 0049). 기본 꺼짐 플래그 `stuckQa` 뒤에 있고, 꺼져 있거나 카드가 지금 보이지 않으면 404입니다.
 * - 막힘 로그를 쓴 사람: "질문 받기" 켜고 끄기(끄면 새 질문·답변을 받지 않고 기존 스레드는 읽기만).
 * - 학교 인증 계정: 질문으로 스레드 열기(원리·접근 위주 안내). 스레드에서는 모두 익명이고, 순서는 "도움됐어요"를 받은 답변이 많은 스레드부터.
 * - 검색엔진에 싣지 않습니다(noindex).
 */
import type { StuckQaCardDto, StuckQaThreadDto } from '~~/shared/types/api'

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const itemKey = computed(() => String(route.params.itemKey))
const url = computed(() => `/api/v1/stuck-qa/cards/${encodeURIComponent(slug.value)}/${encodeURIComponent(itemKey.value)}`)
useHead({ title: '막힘 Q&A — Peerchive', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const { data, error, refresh } = await useFetch<StuckQaCardDto>(url)
if (import.meta.server && error.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const body = ref('')
const busy = ref(false)
const message = ref('')

async function toggle(allowed: boolean) {
  message.value = ''
  busy.value = true
  try {
    data.value = await $fetch<StuckQaCardDto>(url.value, { method: 'PUT', body: { questionsAllowed: allowed } })
  } catch (e) {
    const err = apiError(e)
    message.value = stuckQaErrorMessage(err.code, err.fields)
  } finally {
    busy.value = false
  }
}

async function ask() {
  message.value = ''
  busy.value = true
  try {
    const thread = await $fetch<StuckQaThreadDto>(`${url.value}/threads`, { method: 'POST', body: { body: body.value } })
    body.value = ''
    await navigateTo(`/stuck-qa/threads/${thread.id}`)
  } catch (e) {
    const err = apiError(e)
    message.value = stuckQaErrorMessage(err.code, err.fields)
    await refresh()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <template v-if="error || !data">
      <h1>막힘 Q&A를 찾을 수 없습니다</h1>
      <p>공개가 철회되었거나, 아직 열리지 않은 기능이거나, 주소가 틀렸습니다.</p>
    </template>
    <template v-else>
      <p class="small"><NuxtLink :to="`/p/${data.slug}`">공개 사례로 돌아가기</NuxtLink></p>
      <h1>🧱 막힘 Q&A</h1>
      <blockquote class="pre" data-testid="stuck-qa-symptom">{{ data.symptom }}</blockquote>
      <p class="hint">{{ STUCK_QA_GUIDE }}</p>

      <section v-if="data.viewer?.isLogAuthor" class="fork-box" aria-labelledby="sqa-owner" data-testid="stuck-qa-owner">
        <h2 id="sqa-owner">내 막힘 로그</h2>
        <p class="small">
          질문 받기를 켜면 이 과목 학교 인증 계정이 질문하고 답할 수 있습니다. 내 답변은 익명이어도 "작성자"로 보입니다.
        </p>
        <p class="actions">
          <button v-if="!data.questionsAllowed" type="button" :disabled="busy" data-testid="stuck-qa-allow" @click="toggle(true)">질문 받기 켜기</button>
          <button v-else type="button" class="secondary" :disabled="busy" data-testid="stuck-qa-disallow" @click="toggle(false)">질문 받기 끄기</button>
        </p>
      </section>

      <p v-if="!data.questionsAllowed" class="muted" data-testid="stuck-qa-closed">이 막힘 로그는 지금 질문을 받지 않습니다.</p>

      <section v-else-if="data.viewer && !data.viewer.isLogAuthor" aria-labelledby="sqa-ask">
        <h2 id="sqa-ask">질문하기</h2>
        <template v-if="data.viewer.canWrite">
          <label for="sqa-body">질문(익명, 이 스레드에서는 "질문자"로 보입니다)</label>
          <textarea id="sqa-body" v-model="body" rows="4" maxlength="2000" data-testid="stuck-qa-question" />
          <p class="actions"><button type="button" :disabled="busy || !body.trim()" data-testid="stuck-qa-ask" @click="ask">질문 올리기</button></p>
        </template>
        <p v-else-if="data.viewer.requirement === 'school_affiliation'" class="small">
          이 과목 학교 메일로 인증하면 질문할 수 있습니다. <NuxtLink :to="affiliationPageLink(null, route.fullPath)">학교 인증하기</NuxtLink>
        </p>
        <p v-else class="small muted">지금은 질문할 수 없습니다.</p>
      </section>
      <p v-else-if="!data.viewer" class="small"><NuxtLink to="/login">로그인</NuxtLink>하면 질문할 수 있어요.</p>
      <p v-if="message" class="field-error" role="alert">{{ message }}</p>

      <section aria-labelledby="sqa-threads">
        <h2 id="sqa-threads">질문 {{ data.threads.length }}개</h2>
        <ul v-if="data.threads.length" class="plain" data-testid="stuck-qa-threads">
          <li v-for="t in data.threads" :key="t.id">
            <NuxtLink :to="`/stuck-qa/threads/${t.id}`">{{ t.question }}</NuxtLink>
            <span class="small muted"> · 답변 {{ t.answerCount }}개 · {{ formatDateTime(t.lastPostAt) }}</span>
          </li>
        </ul>
        <p v-else class="muted">아직 질문이 없습니다.</p>
      </section>
    </template>
  </div>
</template>
