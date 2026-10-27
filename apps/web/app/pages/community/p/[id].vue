<script setup lang="ts">
/**
 * 커뮤니티 글과 댓글(C-04, PROOFU_EVOLUTION_PLAN §8.5·§8.9.6, ADR 0022). 로그인 전용·noindex·제목 고정(C-05).
 * - 익명 스레드: 글쓴이는 `글쓴이`, 다른 참여자는 처음 쓴 순서대로 `익명1`·`익명2`(스레드마다 따로). 방장·모더레이터 화면도 같습니다.
 * - 공감만 있고 비추천은 없습니다. 누가 공감했는지는 보이지 않습니다.
 * - 지운 글·댓글은 "작성자가 삭제한 …", 운영 조치로 가린 것은 "운영 조치로 가려진 …"으로 보입니다.
 */
import type { CommunityPostDto, CommunityReactionDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
// 제목·robots·referrer는 공통(C-05): 글 제목으로 문서 제목·OG를 만들지 않습니다.
useCommunityPage()

const route = useRoute()
const postId = computed(() => String(route.params.id ?? ''))
const fetcher = useRequestFetch()
const { data: post, error } = await useAsyncData(`post-${postId.value}`, () => fetcher<CommunityPostDto>(`/api/v1/community/posts/${postId.value}`))
const missing = computed(() => !!error.value || !post.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const showError = (text: string) => (notice.value = { kind: 'error', text })
const showStatus = (text: string) => (notice.value = { kind: 'ok', text })
function fail(e: unknown) {
  const err = apiError(e)
  showError(err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code))
}
function setThread(next: CommunityPostDto) {
  post.value = next
}

// ── 글 고치기·지우기·공감 ──
const editing = ref(false)
const edit = reactive({ title: '', body: '' })
function startEdit() {
  if (!post.value) return
  edit.title = post.value.title ?? ''
  edit.body = post.value.body ?? ''
  editing.value = true
}
async function saveEdit() {
  if (!post.value) return
  busy.value = true
  try {
    setThread(await $fetch<CommunityPostDto>(`/api/v1/community/posts/${postId.value}`, { method: 'PATCH', body: { ...edit, expectedVersion: post.value.version } }))
    editing.value = false
    showStatus('글을 고쳤습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function removePost() {
  if (!window.confirm('이 글을 지울까요? 댓글은 남고 글 자리에는 "작성자가 삭제한 글입니다"가 보입니다.')) return
  busy.value = true
  try {
    setThread(await $fetch<CommunityPostDto>(`/api/v1/community/posts/${postId.value}`, { method: 'DELETE' }))
    showStatus('글을 지웠습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function togglePostReaction() {
  if (!post.value) return
  busy.value = true
  try {
    const r = await $fetch<CommunityReactionDto>(`/api/v1/community/posts/${postId.value}/reaction`, { method: post.value.reacted ? 'DELETE' : 'PUT' })
    post.value = { ...post.value, reactionCount: r.count, reacted: r.reacted }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

// ── 댓글 ──
const comment = reactive({ body: '', nameMode: '' as '' | 'display' })
async function addComment() {
  if (!post.value) return
  busy.value = true
  notice.value = null
  try {
    const body: Record<string, unknown> = { body: comment.body }
    if (post.value.space.official && comment.nameMode) body.nameMode = comment.nameMode
    setThread(await $fetch<CommunityPostDto>(`/api/v1/community/posts/${postId.value}/comments`, { method: 'POST', body }))
    comment.body = ''
    showStatus('댓글을 달았습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="community-page post-page">
    <template v-if="missing">
      <h1>글을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 글을 볼 수 있는 학교 인증·멤버십이 없습니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="post">
      <p class="small">
        <NuxtLink :to="`/community/s/${post.space.slug}`">{{ post.space.name }}</NuxtLink>
        <span v-if="post.space.official" class="badge">공식</span>
        ·
        <NuxtLink :to="`/community/b/${post.board.id}`">{{ post.board.title }}</NuxtLink>
      </p>
      <article aria-labelledby="post-title">
        <h1 id="post-title">{{ post.title ?? post.placeholder }}</h1>
        <p class="small post-meta">
          <strong class="post-author">{{ post.author.label ?? '' }}</strong>
          <span v-if="post.author.schoolVerified"> · 학교 인증</span>
          <span v-if="post.author.mine" class="badge">내 글</span>
          <span class="muted"> · {{ NAME_MODE_LABELS[post.nameMode] }} · {{ communityTimeText(post) }}<template v-if="post.edited"> · 수정됨</template></span>
        </p>
        <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
        <form v-if="editing" class="stack" novalidate @submit.prevent="saveEdit">
          <div class="field">
            <label for="edit-title">제목</label>
            <input id="edit-title" v-model="edit.title" :maxlength="POST_TITLE_MAX" />
          </div>
          <div class="field">
            <label for="edit-body">내용</label>
            <textarea id="edit-body" v-model="edit.body" rows="6" :maxlength="POST_BODY_MAX" />
          </div>
          <p class="hint">고쳐도 이름 표시 방식은 쓸 때 그대로입니다.</p>
          <p class="actions">
            <button type="submit" :disabled="busy">저장</button>
            <button type="button" class="secondary" @click="editing = false">취소</button>
          </p>
        </form>
        <p v-else-if="post.body" class="pre post-body">{{ post.body }}</p>
        <p v-else-if="post.title" class="muted">{{ post.placeholder }}</p>
        <p v-if="!editing" class="actions">
          <button
            v-if="post.canReact"
            type="button"
            class="secondary"
            :aria-pressed="post.reacted"
            :aria-label="`공감 ${post.reactionCount}개${post.reacted ? ', 공감함' : ''}`"
            :disabled="busy"
            @click="togglePostReaction"
          >
            공감 {{ post.reactionCount }}
          </button>
          <span v-else-if="post.status === 'published'" class="muted">공감 {{ post.reactionCount }}</span>
          <button v-if="post.canEdit" type="button" class="link-button" @click="startEdit">고치기</button>
          <button v-if="post.canDelete" type="button" class="link-button" :disabled="busy" @click="removePost">지우기</button>
          <ReportButton
            v-if="post.canReport"
            id-prefix="post"
            :targets="[{ id: post.id, label: '이 글', targetType: 'community_post', targetRef: { postId: post.id } }]"
          />
        </p>
      </article>

      <section aria-labelledby="comments">
        <h2 id="comments">댓글 {{ post.commentCount }}</h2>
        <ul v-if="post.comments.length" class="plain" data-testid="comments">
          <CommunityCommentItem
            v-for="c in post.comments"
            :key="c.id"
            :comment="c"
            :post-id="post.id"
            :official="post.space.official"
            @thread="setThread"
            @error="showError"
            @status="showStatus"
          />
        </ul>
        <p v-else class="muted">아직 댓글이 없습니다.</p>

        <form v-if="post.composer.canWrite" class="stack" novalidate @submit.prevent="addComment">
          <p class="notice small" data-testid="comment-name-mode-note">{{ post.composer.note }}</p>
          <p v-if="post.composer.anonymityNote" class="hint">{{ post.composer.anonymityNote }}</p>
          <p v-if="post.composer.realNameRequired" class="notice error" role="status">
            이 방은 실명으로 표시됩니다. 먼저 <NuxtLink to="/community">커뮤니티 화면</NuxtLink>에서 실명(선택)을 입력하세요.
          </p>
          <fieldset v-if="post.space.official">
            <legend>이름 표시</legend>
            <div class="radio-row">
              <input id="comment-anon" v-model="comment.nameMode" type="radio" name="comment-mode" value="" />
              <label for="comment-anon">익명(기본)</label>
            </div>
            <div class="radio-row">
              <input id="comment-display" v-model="comment.nameMode" type="radio" name="comment-mode" value="display" />
              <label for="comment-display">표시명</label>
            </div>
          </fieldset>
          <div class="field">
            <label for="comment-body">댓글</label>
            <textarea id="comment-body" v-model="comment.body" rows="3" :maxlength="COMMENT_BODY_MAX" aria-describedby="comment-body-hint" />
            <p id="comment-body-hint" class="hint">{{ comment.body.length }}/{{ COMMENT_BODY_MAX }}자</p>
          </div>
          <p class="actions"><button type="submit" :disabled="busy">댓글 달기</button></p>
        </form>
        <p v-else-if="post.status !== 'published'" class="small muted">지워졌거나 가려진 글에는 댓글을 쓸 수 없습니다.</p>
      </section>
      <p><NuxtLink :to="`/community/b/${post.board.id}`">게시판으로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>

<style scoped>
.post-body {
  overflow-wrap: anywhere;
}
.post-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: baseline;
}
</style>
