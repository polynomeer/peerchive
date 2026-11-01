<script setup lang="ts">
/**
 * 커뮤니티 댓글 하나(+ 답글 한 단계)(C-04, ADR 0022). 작성자는 이름·`글쓴이`·`익명N`으로만 보이고 사람 id·프로필 링크가 없습니다.
 * 고치기·지우기는 내 댓글에만, 공감·신고는 남의 게시 중인 댓글에만 보입니다. 서버 응답(스레드 전체)을 부모에게 올려 다시 그립니다.
 * 방 운영진이면(spaceHiddenIds가 null이 아님, C-06) 가리기·되돌리기·제재 요청 도구가 보입니다.
 * 질문 게시판(C-09): 채택된 답변에는 "채택된 답변" 표시가 붙고(작성자 표시는 그대로), 글쓴이(canAccept)는 최상위 댓글을 채택하거나 풉니다.
 * 토픽(A-06): 내 소속 표시 익명 댓글(답변)은 "선배 노트로 옮기기"로 선배 노트 초안을 만들 수 있습니다(이름 표시를 다시 고름).
 */
import type { CommunityCommentDto, CommunityPostDto, CommunityReactionDto } from '~~/shared/types/api'

const props = defineProps<{ comment: CommunityCommentDto; postId: string; official: boolean; spaceHiddenIds?: string[] | null; canAccept?: boolean }>()
const emit = defineEmits<{ thread: [CommunityPostDto]; error: [string]; status: [string]; modChanged: [] }>()

const c = computed(() => props.comment)
const editing = ref(false)
const replying = ref(false)
const editBody = ref('')
const replyBody = ref('')
const replyMode = ref<'' | 'display'>('')
const moving = ref(false)
const canMoveToNote = computed(() => !!c.value.author.mine && c.value.nameMode === 'affiliated_anonymous' && c.value.status === 'published')
const busy = ref(false)
const reaction = ref<CommunityReactionDto>({ count: props.comment.reactionCount, reacted: props.comment.reacted })
watch(
  () => props.comment,
  (v) => (reaction.value = { count: v.reactionCount, reacted: v.reacted }),
)

function fail(e: unknown) {
  const err = apiError(e)
  emit('error', err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code))
}

function startEdit() {
  editBody.value = c.value.body ?? ''
  editing.value = true
}

async function saveEdit() {
  busy.value = true
  try {
    emit('thread', await $fetch<CommunityPostDto>(`/api/v1/community/comments/${c.value.id}`, { method: 'PATCH', body: { body: editBody.value, expectedVersion: c.value.version } }))
    editing.value = false
    emit('status', '댓글을 고쳤습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!window.confirm('이 댓글을 지울까요? 지운 자리에는 "작성자가 삭제한 댓글입니다"가 남습니다.')) return
  busy.value = true
  try {
    emit('thread', await $fetch<CommunityPostDto>(`/api/v1/community/comments/${c.value.id}`, { method: 'DELETE' }))
    emit('status', '댓글을 지웠습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function reply() {
  busy.value = true
  try {
    const body: Record<string, unknown> = { body: replyBody.value, parentCommentId: c.value.id }
    if (props.official && replyMode.value) body.nameMode = replyMode.value
    emit('thread', await $fetch<CommunityPostDto>(`/api/v1/community/posts/${props.postId}/comments`, { method: 'POST', body }))
    replyBody.value = ''
    replying.value = false
    emit('status', '답글을 달았습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function setAccepted(on: boolean) {
  if (!on && !window.confirm('채택을 풀까요? 이 답변을 옮기던 진행 중 요청은 취소됩니다.')) return
  busy.value = true
  try {
    emit(
      'thread',
      await $fetch<CommunityPostDto>(`/api/v1/community/posts/${props.postId}/accepted-answer`, on ? { method: 'PUT', body: { commentId: c.value.id } } : { method: 'DELETE' }),
    )
    emit('status', on ? '이 답변을 채택했습니다.' : '채택을 풀었습니다.')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function toggleReaction() {
  busy.value = true
  try {
    reaction.value = await $fetch<CommunityReactionDto>(`/api/v1/community/comments/${c.value.id}/reaction`, { method: reaction.value.reacted ? 'DELETE' : 'PUT' })
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <li class="comment" :data-testid="`comment-${c.id}`">
    <p class="small comment-meta">
      <strong class="comment-author">{{ c.author.label ?? '' }}</strong>
      <span v-if="c.affiliationLabel" data-testid="comment-affiliation-label"> · {{ c.affiliationLabel }}</span>
      <span v-if="c.labelBroadened" class="hint"> (넓혀 표시됨 · 나에게만 보이는 안내)</span>
      <RoomBadges :tag="c.author.roomProfile" />
      <span v-if="c.author.schoolVerified"> · 학교 인증</span>
      <span v-if="c.author.mine" class="badge">내 댓글</span>
      <span v-if="c.accepted" class="badge accepted" data-testid="accepted-badge">채택된 답변</span>
      <span class="muted"> · {{ communityTimeText(c) }}<template v-if="c.edited"> · 수정됨</template></span>
    </p>
    <template v-if="editing">
      <form class="stack" novalidate @submit.prevent="saveEdit">
        <div class="field">
          <label :for="`edit-${c.id}`">댓글 고치기</label>
          <textarea :id="`edit-${c.id}`" v-model="editBody" rows="3" :maxlength="COMMENT_BODY_MAX" />
        </div>
        <p class="actions">
          <button type="submit" :disabled="busy">저장</button>
          <button type="button" class="secondary" @click="editing = false">취소</button>
        </p>
      </form>
    </template>
    <p v-else-if="c.body" class="pre comment-body">{{ c.body }}</p>
    <p v-else class="muted comment-body">{{ c.placeholder }}</p>
    <p v-if="c.status === 'auto_hidden' && c.author.mine" class="hint">내 댓글이 여러 사람의 신고로 운영 검토 중이라 다른 사람에게는 임시로 가려져 있습니다.</p>
    <p v-if="!editing" class="actions small">
      <button
        v-if="c.canReact"
        type="button"
        class="link-button"
        :aria-pressed="reaction.reacted"
        :aria-label="`공감 ${reaction.count}개${reaction.reacted ? ', 공감함' : ''}`"
        :disabled="busy"
        @click="toggleReaction"
      >
        공감 {{ reaction.count }}
      </button>
      <span v-else-if="c.status === 'published'" class="muted">공감 {{ reaction.count }}</span>
      <button v-if="c.canReply" type="button" class="link-button" :aria-expanded="replying" @click="replying = !replying">답글</button>
      <button
        v-if="canAccept && !c.parentId && c.status === 'published' && !c.accepted"
        type="button"
        class="link-button"
        :disabled="busy"
        :data-testid="`accept-${c.id}`"
        @click="setAccepted(true)"
      >
        이 답변 채택
      </button>
      <button v-if="canAccept && c.accepted" type="button" class="link-button" :disabled="busy" @click="setAccepted(false)">채택 풀기</button>
      <button v-if="c.canEdit" type="button" class="link-button" @click="startEdit">고치기</button>
      <button
        v-if="canMoveToNote"
        type="button"
        class="link-button"
        :aria-expanded="moving"
        :data-testid="`move-to-note-${c.id}`"
        @click="moving = !moving"
      >
        선배 노트로 옮기기
      </button>
      <button v-if="c.canDelete" type="button" class="link-button" :disabled="busy" @click="remove">지우기</button>
      <ReportButton
        v-if="c.canReport"
        :id-prefix="`comment-${c.id}`"
        :targets="[{ id: c.id, label: '이 댓글', targetType: 'community_comment', targetRef: { commentId: c.id } }]"
      />
      <CommunityModTools
        v-if="spaceHiddenIds"
        kind="comment"
        :item-id="c.id"
        :status="c.status"
        :space-hidden="spaceHiddenIds.includes(c.id)"
        :id-prefix="`comment-mod-${c.id}`"
        @thread="emit('thread', $event)"
        @changed="emit('modChanged')"
        @error="emit('error', $event)"
        @status="emit('status', $event)"
      />
    </p>
    <ArchiveTransferForm v-if="moving" :post-id="postId" :comment-id="c.id" @close="moving = false" />
    <form v-if="replying" class="stack" novalidate @submit.prevent="reply">
      <fieldset v-if="official">
        <legend>이름 표시</legend>
        <div class="radio-row">
          <input :id="`reply-anon-${c.id}`" v-model="replyMode" type="radio" :name="`reply-mode-${c.id}`" value="" />
          <label :for="`reply-anon-${c.id}`">익명(기본)</label>
        </div>
        <div class="radio-row">
          <input :id="`reply-display-${c.id}`" v-model="replyMode" type="radio" :name="`reply-mode-${c.id}`" value="display" />
          <label :for="`reply-display-${c.id}`">표시명</label>
        </div>
      </fieldset>
      <div class="field">
        <label :for="`reply-${c.id}`">답글</label>
        <textarea :id="`reply-${c.id}`" v-model="replyBody" rows="2" :maxlength="COMMENT_BODY_MAX" />
      </div>
      <p class="actions"><button type="submit" :disabled="busy">답글 달기</button></p>
    </form>
    <ul v-if="c.replies.length" class="plain replies">
      <CommunityCommentItem
        v-for="r in c.replies"
        :key="r.id"
        :comment="r"
        :post-id="postId"
        :official="official"
        :space-hidden-ids="spaceHiddenIds"
        @thread="emit('thread', $event)"
        @mod-changed="emit('modChanged')"
        @error="emit('error', $event)"
        @status="emit('status', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
.comment {
  border-top: 1px solid var(--border, #ddd);
  padding: 0.5rem 0;
  overflow-wrap: anywhere;
}
.replies {
  margin-left: 1rem;
  padding-left: 0.5rem;
  border-left: 2px solid var(--border, #ddd);
}
.comment-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: baseline;
}
</style>
