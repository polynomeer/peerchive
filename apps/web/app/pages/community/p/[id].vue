<script setup lang="ts">
/**
 * 커뮤니티 글과 댓글(C-04, PROOFU_EVOLUTION_PLAN §8.5·§8.9.6, ADR 0022). 로그인 전용·noindex·제목 고정(C-05).
 * - 익명 스레드: 글쓴이는 `글쓴이`, 다른 참여자는 처음 쓴 순서대로 `익명1`·`익명2`(스레드마다 따로). 방장·모더레이터 화면도 같습니다.
 * - 공감만 있고 비추천은 없습니다. 누가 공감했는지는 보이지 않습니다.
 * - 지운 글·댓글은 "작성자가 삭제한 …", 운영 조치로 가린 것은 "운영 조치로 가려진 …", 신고 누적 임시 숨김은 "운영 검토 중"으로 보입니다(C-06).
 * - 방 운영진(방장·admin·moderator)에게는 가리기·되돌리기·제재 요청 도구가 보입니다(C-06). 글 응답(DTO)은 누구에게나 같고, 운영진 여부는
 *   공간 상세의 permissions.moderate와 별도 운영 화면(`/spaces/:slug/moderation`)으로만 압니다. 운영진도 익명 작성자를 볼 수 없습니다.
 * - 질문 게시판(C-09, ADR 0025): 글쓴이는 답변 하나를 채택하고, 글을 "아카이브로 옮기기"(막힘 Q&A·내 과제의 막힘 로그·선배 노트 초안)할 수 있습니다.
 *   지금 공개된 복사본이 있으면 "아카이브로 옮겨짐" 표시만 보입니다(링크·동의한 사람 없음). 내가 요청했거나 동의를 요청받은 요청만 상태와 함께 보입니다.
 * - 동문회·OB 방의 공지(A-02, ADR 0039): 글을 열면 읽었다고 표시하고 "읽음 n명"만 보입니다. 누가 읽었는지는 방장·운영진에게도 보이지 않습니다.
 * - 공감 라운지(공식 학교 페이지 자유 게시판, A-04·ADR 0041): 검사·메타데이터 제거를 통과한 이미지만 짧은 서명 URL로, 글쓴이는 이미지를 붙이고 지웁니다.
 *   졸업생 인증 이력으로 읽는 사람에게는 읽기 전용 안내가 보입니다.
 */
import type { CommunityPostDto, CommunityReactionDto, SpaceDetailDto, SpaceModerationDto } from '~~/shared/types/api'

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
// 공감 라운지 이미지(A-04)를 붙이거나 지운 뒤: 새 서명 URL과 검사 상태를 다시 받습니다.
async function reloadPost() {
  try {
    setThread(await $fetch<CommunityPostDto>(`/api/v1/community/posts/${postId.value}`))
  } catch (e) {
    fail(e)
  }
}

// ── 방 운영진 도구(C-06) ──
const moderation = ref<SpaceModerationDto | null>(null)
async function loadModeration() {
  if (!post.value) return
  try {
    const space = await $fetch<SpaceDetailDto>(`/api/v1/community/spaces/${post.value.space.slug}`)
    moderation.value = space.permissions.moderate ? await $fetch<SpaceModerationDto>(`/api/v1/community/spaces/${post.value.space.slug}/moderation`) : null
  } catch {
    moderation.value = null
  }
}
onMounted(loadModeration)

// 동문회·OB 방 공지(A-02): 열면 읽음 표시(멱등). 읽음 수만 받습니다.
async function markRead() {
  if (!post.value?.noticeReads || post.value.noticeReads.readByMe) return
  try {
    const reads = await $fetch<{ count: number; readByMe: boolean }>(`/api/v1/community/posts/${postId.value}/read`, { method: 'POST' })
    if (post.value) post.value = { ...post.value, noticeReads: reads }
  } catch {
    // 읽음 표시는 부가 기능이라 실패해도 글은 그대로 봅니다.
  }
}
onMounted(markRead)
const spaceHiddenIds = computed(() => (moderation.value ? moderation.value.hides.map((h) => h.commentId ?? h.postId) : null))
const postSpaceHidden = computed(() => !!moderation.value?.hides.some((h) => h.targetType === 'post' && h.postId === postId.value))

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

// ── 아카이브로 옮기기(C-09) ──
const archiveOpen = ref(false)
const transferText = (t: { target: keyof typeof ARCHIVE_TARGET_LABELS; status: keyof typeof ARCHIVE_STATUS_LABELS; cancelReason: string | null }) =>
  `${ARCHIVE_TARGET_LABELS[t.target]} · ${ARCHIVE_STATUS_LABELS[t.status]}`

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
          <RoomBadges :tag="post.author.roomProfile" />
          <span v-if="post.author.schoolVerified"> · 학교 인증</span>
          <span v-if="post.author.mine" class="badge">내 글</span>
          <span class="muted"> · {{ NAME_MODE_LABELS[post.nameMode] }} · {{ communityTimeText(post) }}<template v-if="post.edited"> · 수정됨</template></span>
          <span v-if="post.noticeReads" class="muted" data-testid="notice-reads"> · 읽음 {{ post.noticeReads.count }}명</span>
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
        <LoungeMedia v-if="post.lounge && !editing" :post-id="post.id" :lounge="post.lounge" @changed="reloadPost" />
        <p v-if="post.alumniHistoryOnly" class="small muted" data-testid="alumni-history-note">졸업생 인증 이력으로 읽는 중입니다. 댓글·공감은 이 학교 메일 인증이 지금 유지될 때만 쓸 수 있습니다.</p>
        <p v-if="post.archive.archived" class="small" data-testid="archived-marker"><span class="badge">{{ ARCHIVED_MARKER_TEXT }}</span></p>
        <p v-if="post.status === 'auto_hidden' && post.author.mine" class="notice" role="status" data-testid="own-review-notice">
          내 글이 여러 사람의 신고로 운영 검토 중이라 다른 사람에게는 임시로 가려져 있습니다. 검토가 끝나면
          <NuxtLink to="/community/notices">커뮤니티 알림</NuxtLink>으로 결과를 알려 드립니다.
        </p>
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
          <CommunityModTools
            v-if="moderation"
            kind="post"
            :item-id="post.id"
            :status="post.status"
            :space-hidden="postSpaceHidden"
            id-prefix="post-mod"
            @thread="setThread"
            @changed="loadModeration"
            @error="showError"
            @status="showStatus"
          />
        </p>
      </article>

      <section v-if="post.archive.transfers.length || post.archive.canStart" aria-labelledby="archive-heading" class="stack">
        <h2 id="archive-heading" class="small-heading">아카이브로 옮기기</h2>
        <ul v-if="post.archive.transfers.length" class="plain" data-testid="archive-transfers">
          <li v-for="t in post.archive.transfers" :key="t.id">
            <NuxtLink :to="`/community/archive-transfers/${t.id}`">{{ transferText(t) }}</NuxtLink>
            <span v-if="t.myRole === 'party' && t.myConsent === 'pending' && t.status === 'awaiting_consent'" class="badge">내 동의 필요</span>
          </li>
        </ul>
        <template v-if="post.archive.canStart">
          <p v-if="post.archive.questionBoard && !post.acceptedCommentId" class="hint">
            답변을 채택하면 질문과 답변을 과목 허브의 막힘 Q&amp;A나 내 과제의 막힘 로그로 옮길 수 있습니다.
          </p>
          <p v-if="!archiveOpen" class="actions">
            <button type="button" class="secondary" data-testid="archive-open" @click="archiveOpen = true">아카이브로 옮기기</button>
          </p>
          <ArchiveTransferForm v-else :post-id="post.id" @close="archiveOpen = false" />
        </template>
      </section>

      <section aria-labelledby="comments">
        <h2 id="comments">댓글 {{ post.commentCount }}</h2>
        <ul v-if="post.comments.length" class="plain" data-testid="comments">
          <CommunityCommentItem
            v-for="c in post.comments"
            :key="c.id"
            :comment="c"
            :post-id="post.id"
            :official="post.space.official"
            :space-hidden-ids="spaceHiddenIds"
            :can-accept="post.canAccept"
            @thread="setThread"
            @mod-changed="loadModeration"
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
          <p
            v-if="post.composer.displayPersonaRequired && (!post.space.official || comment.nameMode === 'display')"
            class="notice error"
            role="status"
            data-testid="display-persona-required"
          >
            {{ post.space.official ? '표시명으로 쓰려면' : '이 방은 표시명으로 표시됩니다.' }} 먼저 <NuxtLink to="/settings/personas">표시명 프로필</NuxtLink>을 만드세요.
            계정 이름은 표시명으로 쓰지 않습니다.
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
        <p v-else-if="post.composer.restriction" class="notice error" role="status" data-testid="write-restriction">
          {{ post.composer.restriction.message }}<template v-if="post.composer.restriction.until"> ({{ formatDateTime(post.composer.restriction.until) }}까지)</template>
        </p>
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
