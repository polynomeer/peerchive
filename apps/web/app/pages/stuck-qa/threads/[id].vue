<script setup lang="ts">
/**
 * 막힘 Q&A 스레드(E-04, ADR 0049). 질문 먼저, 답변은 "도움됐어요"를 많이 받은 순 → 먼저 쓴 순. 개수는 보여 주지 않습니다(정렬에만, 개인 점수 없음).
 * - 표시: `질문자`·`익명N`(이 스레드 안에서만 같은 번호)·`작성자`(막힘 로그를 쓴 사람). 이름·프로필 링크는 없습니다.
 * - 내 답변: 포트폴리오 "후배 기여"에 넣을지(기본 꺼짐), 지우기. 남의 답변: 도움됐어요, 신고.
 * - 카드가 닫히면(질문 받기 꺼짐) 읽기만. 공개가 철회되면 404. 검색엔진에 싣지 않습니다.
 */
import type { StuckQaPostDto, StuckQaThreadDto } from '~~/shared/types/api'
import type { ReportChoice } from '~/utils/moderation'

const route = useRoute()
const id = computed(() => String(route.params.id))
const url = computed(() => `/api/v1/stuck-qa/threads/${encodeURIComponent(id.value)}`)
useHead({ title: '막힘 Q&A 스레드 — Peerchive', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const { data, error, refresh } = await useFetch<StuckQaThreadDto>(url)
if (import.meta.server && error.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const body = ref('')
const countAsContribution = ref(false)
const busy = ref(false)
const message = ref('')

async function run(fn: () => Promise<unknown>) {
  message.value = ''
  busy.value = true
  try {
    await fn()
  } catch (e) {
    const err = apiError(e)
    message.value = stuckQaErrorMessage(err.code, err.fields)
  } finally {
    busy.value = false
  }
}

const answer = () =>
  run(async () => {
    data.value = await $fetch<StuckQaThreadDto>(`${url.value}/posts`, { method: 'POST', body: { body: body.value, countAsContribution: countAsContribution.value } })
    body.value = ''
    countAsContribution.value = false
  })
const helpful = (post: StuckQaPostDto) =>
  run(async () => {
    await $fetch(`/api/v1/stuck-qa/posts/${post.id}/helpful`, { method: post.helpedByMe ? 'DELETE' : 'PUT' })
    await refresh()
  })
const contribution = (post: StuckQaPostDto) =>
  run(async () => {
    await $fetch(`/api/v1/stuck-qa/posts/${post.id}`, { method: 'PATCH', body: { countAsContribution: !post.countAsContribution } })
    await refresh()
  })
const withdraw = (post: StuckQaPostDto) =>
  run(async () => {
    await $fetch(`/api/v1/stuck-qa/posts/${post.id}`, { method: 'DELETE' })
    if (post.kind === 'question') await navigateTo(data.value ? `/stuck-qa/cards/${data.value.slug}/${encodeURIComponent(data.value.itemKey)}` : '/')
    else await refresh()
  })

const reportTargets = (post: StuckQaPostDto): ReportChoice[] => [
  { id: post.id, label: `${post.label}의 ${post.kind === 'question' ? '질문' : '답변'}`, targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: post.id } },
]
</script>

<template>
  <div>
    <template v-if="error || !data">
      <h1>스레드를 찾을 수 없습니다</h1>
      <p>질문이 지워졌거나, 공개가 철회되었거나, 주소가 틀렸습니다.</p>
    </template>
    <template v-else>
      <p class="small">
        <NuxtLink :to="`/stuck-qa/cards/${data.slug}/${encodeURIComponent(data.itemKey)}`">이 막힘 카드의 다른 질문</NuxtLink>
        · <NuxtLink :to="`/p/${data.slug}`">공개 사례</NuxtLink>
      </p>
      <h1>🧱 막힘 Q&A 스레드</h1>
      <blockquote class="pre">{{ data.symptom }}</blockquote>
      <p class="hint">{{ STUCK_QA_GUIDE }}</p>

      <ol class="plain" data-testid="stuck-qa-posts">
        <li v-for="post in data.posts" :key="post.id" :data-testid="`stuck-qa-post-${post.kind}`">
          <p>
            <strong data-testid="stuck-qa-label">{{ post.label }}</strong>
            <span v-if="post.kind === 'question'" class="badge">질문</span>
            <span class="small muted"> · {{ formatDateTime(post.createdAt) }}</span>
          </p>
          <p v-if="post.body !== null" class="pre">{{ post.body }}</p>
          <p v-else class="muted small">{{ post.status === 'hidden' ? '운영 조치로 가려진 글입니다.' : '작성자가 지운 글입니다.' }}</p>
          <p v-if="post.body !== null" class="actions small">
            <button
              v-if="data.viewer && !post.mine && post.kind === 'answer'"
              type="button"
              class="secondary"
              :aria-pressed="post.helpedByMe"
              :disabled="busy"
              data-testid="stuck-qa-helpful"
              @click="helpful(post)"
            >
              {{ post.helpedByMe ? '도움됐어요 취소' : '도움됐어요' }}
            </button>
            <label v-if="post.mine && post.kind === 'answer'" class="inline">
              <input type="checkbox" :checked="!!post.countAsContribution" :disabled="busy" data-testid="stuck-qa-contribution" @change="contribution(post)" />
              포트폴리오 "후배 기여"에 넣기
            </label>
            <button v-if="post.mine" type="button" class="secondary" :disabled="busy" @click="withdraw(post)">지우기</button>
            <ReportButton v-if="!post.mine" :targets="reportTargets(post)" :id-prefix="`sqa-${post.id}`" label="신고" />
          </p>
        </li>
      </ol>
      <p class="hint">"도움됐어요"는 답변 순서에만 쓰고, 누가 몇 번 받았는지는 어디에도 보이지 않습니다.</p>

      <section v-if="data.open" aria-labelledby="sqa-answer">
        <h2 id="sqa-answer">답하기</h2>
        <template v-if="data.viewer?.canWrite">
          <label for="sqa-answer-body">답변({{ data.viewer.isLogAuthor ? '"작성자"로 보입니다' : '익명, 이 스레드 안에서만 같은 번호' }})</label>
          <textarea id="sqa-answer-body" v-model="body" rows="4" maxlength="2000" data-testid="stuck-qa-answer-body" />
          <label class="inline">
            <input v-model="countAsContribution" type="checkbox" />
            이 답변을 내 포트폴리오 "후배 기여" 개수에 넣기(기본 꺼짐)
          </label>
          <p class="actions"><button type="button" :disabled="busy || !body.trim()" data-testid="stuck-qa-answer" @click="answer">답변 올리기</button></p>
        </template>
        <p v-else-if="data.viewer?.requirement === 'school_affiliation'" class="small">
          이 과목 학교 메일로 인증하면 답할 수 있습니다. <NuxtLink :to="affiliationPageLink(null, route.fullPath)">학교 인증하기</NuxtLink>
        </p>
        <p v-else-if="!data.viewer" class="small"><NuxtLink to="/login">로그인</NuxtLink>하면 답할 수 있어요.</p>
      </section>
      <p v-else class="muted">막힘 로그 작성자가 질문 받기를 꺼서 새 답변을 받지 않습니다.</p>
      <p v-if="message" class="field-error" role="alert">{{ message }}</p>
    </template>
  </div>
</template>
