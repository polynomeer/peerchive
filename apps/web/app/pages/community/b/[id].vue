<script setup lang="ts">
/**
 * 커뮤니티 게시판(C-04, ADR 0022). 글 목록(최신순, 지운 글은 빠지고 가린 글은 자리 표시)과 글쓰기. 로그인 전용·noindex·제목 고정(C-05).
 * - 글쓰기 화면에 이 공간의 이름 표시 방식을 항상 보여 줍니다(서버가 쓰는 순간 다시 정해 고정). 공식 페이지는 익명 기본·표시명 선택.
 * - 작성자는 이름·`글쓴이`·`익명N`·`탈퇴한 사용자`로만 보이고 사람 id·프로필 링크가 없습니다.
 */
import type { BoardPostsDto, CommunityPostDto, NameMode } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
// 제목·robots·referrer는 공통(C-05): 게시판·글 제목으로 문서 제목·OG를 만들지 않습니다.
useCommunityPage()

const route = useRoute()
const boardId = computed(() => String(route.params.id ?? ''))
const fetcher = useRequestFetch()
const { data, error, refresh } = await useAsyncData(`board-${boardId.value}`, () => fetcher<BoardPostsDto>(`/api/v1/community/boards/${boardId.value}/posts`))
const missing = computed(() => !!error.value || !data.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const more = ref<BoardPostsDto['items']>([])
const cursor = ref<string | null>(null)
watch(
  data,
  (d) => {
    more.value = []
    cursor.value = d?.nextCursor ?? null
  },
  { immediate: true },
)
const items = computed(() => [...(data.value?.items ?? []), ...more.value])

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const form = reactive({ title: '', body: '', nameMode: '' as NameMode | '' })
const fieldErrors = ref<Record<string, string>>({})
const FIELD_TEXT: Record<string, string> = {
  required: '내용을 입력하세요.',
  too_long: '너무 깁니다.',
  invalid: '쓸 수 없는 글자가 있습니다.',
  real_not_allowed: '공식 페이지에서는 실명으로 쓸 수 없습니다.',
  mode_fixed: '이 방의 이름 표시 방식으로만 쓸 수 있습니다.',
}

async function loadMore() {
  if (!cursor.value) return
  busy.value = true
  try {
    const page = await $fetch<BoardPostsDto>(`/api/v1/community/boards/${boardId.value}/posts`, { query: { cursor: cursor.value } })
    more.value.push(...page.items)
    cursor.value = page.nextCursor
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  } finally {
    busy.value = false
  }
}

async function submit() {
  if (!data.value) return
  busy.value = true
  notice.value = null
  fieldErrors.value = {}
  try {
    const body: Record<string, unknown> = { title: form.title, body: form.body }
    if (data.value.space.official && form.nameMode) body.nameMode = form.nameMode
    const post = await $fetch<CommunityPostDto>(`/api/v1/community/boards/${boardId.value}/posts`, { method: 'POST', body })
    form.title = ''
    form.body = ''
    await navigateTo(`/community/p/${post.id}`)
  } catch (e) {
    const err = apiError(e)
    fieldErrors.value = err.fields
    notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
    if (err.code !== 'validation_failed') await refresh()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="community-page board-page">
    <template v-if="missing">
      <h1>게시판을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 게시판을 볼 수 있는 학교 인증·멤버십이 없습니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="data">
      <p class="small">
        <NuxtLink :to="`/community/s/${data.space.slug}`">{{ data.space.name }}</NuxtLink>
        <span v-if="data.space.official" class="badge">공식</span>
      </p>
      <h1>{{ data.board.title }}</h1>
      <p v-if="data.space.status !== 'active'" class="notice error" role="status">{{ SPACE_STATUS_LABELS[data.space.status] }}</p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <p v-if="data.composer.restriction" class="notice error" role="status" data-testid="write-restriction">
        {{ data.composer.restriction.message }}<template v-if="data.composer.restriction.until"> ({{ formatDateTime(data.composer.restriction.until) }}까지)</template>
        <NuxtLink to="/me/moderation-notices">운영 조치 안내 보기</NuxtLink>
      </p>
      <section v-if="data.composer.canWrite" aria-labelledby="compose">
        <h2 id="compose">글쓰기</h2>
        <p class="notice" data-testid="name-mode-note">{{ data.composer.note }}</p>
        <p v-if="data.composer.anonymityNote" class="hint">{{ data.composer.anonymityNote }}</p>
        <p v-if="data.composer.realNameRequired" class="notice error" role="status">
          이 방은 실명으로 표시됩니다. 먼저 <NuxtLink to="/community">커뮤니티 화면</NuxtLink>에서 실명(선택)을 입력하세요.
        </p>
        <p
          v-if="data.composer.displayPersonaRequired && (!data.space.official || form.nameMode === 'display')"
          class="notice error"
          role="status"
          data-testid="display-persona-required"
        >
          {{ data.space.official ? '표시명으로 쓰려면' : '이 방은 표시명으로 표시됩니다.' }} 먼저 <NuxtLink to="/settings/personas">표시명 프로필</NuxtLink>을 만드세요.
          계정 이름은 표시명으로 쓰지 않습니다.
        </p>
        <form class="stack" novalidate @submit.prevent="submit">
          <fieldset v-if="data.space.official">
            <legend>이름 표시</legend>
            <div class="radio-row">
              <input id="mode-anonymous" v-model="form.nameMode" type="radio" name="post-mode" value="" />
              <label for="mode-anonymous">익명(기본)</label>
            </div>
            <div class="radio-row">
              <input id="mode-display" v-model="form.nameMode" type="radio" name="post-mode" value="display" />
              <label for="mode-display">표시명</label>
            </div>
          </fieldset>
          <div class="field">
            <label for="post-title">제목</label>
            <input id="post-title" v-model="form.title" :maxlength="POST_TITLE_MAX" required aria-describedby="post-title-error" />
            <p v-if="fieldErrors.title" id="post-title-error" class="field-error">{{ FIELD_TEXT[fieldErrors.title] ?? fieldMessage(fieldErrors.title) }}</p>
          </div>
          <div class="field">
            <label for="post-body">내용</label>
            <textarea id="post-body" v-model="form.body" rows="6" :maxlength="POST_BODY_MAX" required aria-describedby="post-body-hint post-body-error" />
            <p id="post-body-hint" class="hint">{{ form.body.length }}/{{ POST_BODY_MAX }}자</p>
            <p v-if="fieldErrors.body" id="post-body-error" class="field-error">{{ FIELD_TEXT[fieldErrors.body] ?? fieldMessage(fieldErrors.body) }}</p>
            <p v-if="fieldErrors.nameMode" class="field-error">{{ FIELD_TEXT[fieldErrors.nameMode] ?? fieldMessage(fieldErrors.nameMode) }}</p>
          </div>
          <p class="actions"><button type="submit" :disabled="busy">글 올리기</button></p>
        </form>
      </section>
      <p v-else class="small muted">
        {{ data.board.writeRole === 'moderator' ? '이 게시판은 운영진·모더레이터만 글을 씁니다.' : '이 게시판에 쓸 자격이 없습니다.' }}
      </p>

      <section aria-labelledby="posts">
        <h2 id="posts">글 목록</h2>
        <ul v-if="items.length" class="plain hub-list" data-testid="post-list">
          <li v-for="p in items" :key="p.id" class="hub-card">
            <p>
              <NuxtLink v-if="p.title" :to="`/community/p/${p.id}`">
                <strong>{{ p.title }}</strong>
              </NuxtLink>
              <span v-else class="muted">{{ p.placeholder }}</span>
            </p>
            <p class="small muted">
              <span>{{ p.author.label ?? '' }}</span>
              <span v-if="p.author.schoolVerified"> · 학교 인증</span>
              <span v-if="p.author.mine"> · 내 글</span>
              · {{ communityTimeText(p) }}<template v-if="p.edited"> · 수정됨</template> · 댓글 {{ p.commentCount }} · 공감 {{ p.reactionCount }}
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 글이 없습니다.</p>
        <p v-if="cursor" class="actions"><button type="button" class="secondary" :disabled="busy" @click="loadMore">더 보기</button></p>
      </section>
      <p><NuxtLink :to="`/community/s/${data.space.slug}`">공간으로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>
