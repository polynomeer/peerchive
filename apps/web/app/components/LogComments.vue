<script setup lang="ts">
/**
 * 로그별 피드백 댓글(E-10, ADR 0054). 처음에는 개수만 보이고 펼치면 불러옵니다.
 * 팀원만 보며 공개 페이지에는 실리지 않습니다. 쓰기는 owner/editor/reviewer, 수정·삭제는 작성자, 숨김은 owner(권한은 서버가 준 플래그로).
 * 삭제는 되돌릴 수 없지만 본문만 비우는 소프트 삭제라 확인 창 없이 바로 처리하고 결과를 role=status로 알립니다.
 */
import type { LogCommentDto, LogCommentListDto } from '~~/shared/types/api'

const BODY_MAX = 2000

const props = defineProps<{ logId: string; count: number; currentRevision: number }>()

const open = ref(false)
const data = ref<LogCommentListDto | null>(null)
const loadError = ref(false)
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const draft = ref('')
const draftError = ref<string | null>(null)
const saving = ref(false)
const editingId = ref<string | null>(null)
const editDraft = ref('')
const busyId = ref<string | null>(null)

const regionId = computed(() => `log-${props.logId}-comments`)
const inputId = computed(() => `log-${props.logId}-comment-input`)
const publishedCount = computed(() => (data.value ? data.value.items.filter((c) => c.status === 'published').length : props.count))

async function load() {
  loadError.value = false
  try {
    data.value = await $fetch<LogCommentListDto>(`/api/v1/logs/${props.logId}/comments`)
  } catch {
    loadError.value = true
  }
}

async function toggle() {
  open.value = !open.value
  status.value = null
  if (open.value) await load()
}

function errorText(e: unknown): string {
  const error = apiError(e)
  if (error.status === 422) return error.fields.body === 'too_long' ? `${BODY_MAX}자까지 쓸 수 있습니다.` : '내용을 입력하세요.'
  if (error.status === 429) return '잠시 뒤에 다시 시도하세요. 짧은 시간에 댓글을 너무 많이 남겼습니다.'
  if (error.code === 'project_archived') return '보관된 과제라 댓글을 쓰거나 고칠 수 없습니다.'
  if (error.code === 'limit_reached') return '이 로그에는 댓글을 더 남길 수 없습니다.'
  if (error.status === 403) return '이 작업을 할 권한이 없습니다.'
  if (error.status === 404) return '로그나 댓글을 찾을 수 없습니다. 새로 고침해 보세요.'
  return '처리하지 못했습니다. 입력은 남아 있습니다. 다시 시도하세요.'
}

function replace(updated: LogCommentDto) {
  if (!data.value) return
  data.value.items = data.value.items.map((c) => (c.id === updated.id ? updated : c))
}

async function submit() {
  draftError.value = null
  status.value = null
  if (!draft.value.trim()) {
    draftError.value = '내용을 입력하세요.'
    return
  }
  saving.value = true
  try {
    const created = await $fetch<LogCommentDto>(`/api/v1/logs/${props.logId}/comments`, { method: 'POST', body: { body: draft.value } })
    data.value?.items.push(created)
    draft.value = ''
    status.value = { kind: 'ok', text: '댓글을 남겼습니다.' }
  } catch (e) {
    draftError.value = errorText(e)
  } finally {
    saving.value = false
  }
}

function startEdit(comment: LogCommentDto) {
  editingId.value = comment.id
  editDraft.value = comment.body ?? ''
  status.value = null
}

async function saveEdit(comment: LogCommentDto) {
  busyId.value = comment.id
  try {
    replace(await $fetch<LogCommentDto>(`/api/v1/log-comments/${comment.id}`, { method: 'PATCH', body: { body: editDraft.value } }))
    editingId.value = null
    status.value = { kind: 'ok', text: '댓글을 고쳤습니다.' }
  } catch (e) {
    status.value = { kind: 'error', text: errorText(e) }
  } finally {
    busyId.value = null
  }
}

async function remove(comment: LogCommentDto) {
  busyId.value = comment.id
  try {
    replace(await $fetch<LogCommentDto>(`/api/v1/log-comments/${comment.id}`, { method: 'DELETE' }))
    status.value = { kind: 'ok', text: '댓글을 삭제했습니다.' }
  } catch (e) {
    status.value = { kind: 'error', text: errorText(e) }
  } finally {
    busyId.value = null
  }
}

async function setHidden(comment: LogCommentDto, hidden: boolean) {
  busyId.value = comment.id
  try {
    replace(await $fetch<LogCommentDto>(`/api/v1/log-comments/${comment.id}/hidden`, { method: 'PUT', body: { hidden } }))
    status.value = { kind: 'ok', text: hidden ? '댓글을 숨겼습니다. 작성자와 owner만 내용을 봅니다.' : '숨김을 풀었습니다.' }
  } catch (e) {
    status.value = { kind: 'error', text: errorText(e) }
  } finally {
    busyId.value = null
  }
}

const authorName = (c: LogCommentDto) => (c.author ? c.author.displayName || c.author.handle || '이름 미설정' : '')
</script>

<template>
  <div class="log-comments">
    <button type="button" class="link-button" :aria-expanded="open" :aria-controls="regionId" @click="toggle">
      {{ open ? '피드백 댓글 닫기' : `피드백 댓글 ${publishedCount}개` }}
    </button>
    <section v-if="open" :id="regionId" class="history" :aria-label="`피드백 댓글 (${publishedCount}개)`">
      <p class="hint small">팀원만 볼 수 있고 공개 페이지·검색에는 실리지 않습니다.</p>
      <p v-if="loadError" class="field-error" role="alert">댓글을 불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button></p>
      <p v-else-if="!data" class="muted" role="status">불러오는 중…</p>
      <template v-else>
        <p v-if="data.items.length === 0" class="muted">아직 댓글이 없습니다.</p>
        <ol v-else class="plain comment-list" aria-label="댓글 목록 (오래된 순)">
          <li v-for="comment in data.items" :key="comment.id" class="comment-item">
            <template v-if="comment.status === 'deleted'">
              <p class="muted">삭제된 댓글입니다.</p>
            </template>
            <template v-else-if="comment.status === 'hidden' && comment.body === null">
              <p class="muted">owner가 숨긴 댓글입니다.</p>
            </template>
            <template v-else>
              <p class="small">
                <strong>{{ authorName(comment) }}</strong>
                <span class="muted">
                  · <time :datetime="comment.createdAt">{{ formatDateTime(comment.createdAt) }}</time>
                  <template v-if="comment.revisionNo !== currentRevision"> · r{{ comment.revisionNo }}에 남김</template>
                  <template v-if="comment.editedAt"> · 수정됨</template>
                </span>
                <span v-if="comment.status === 'hidden'" class="badge">숨김 (작성자·owner만 보임)</span>
              </p>
              <form v-if="editingId === comment.id" class="stack" novalidate @submit.prevent="saveEdit(comment)">
                <label :for="`comment-edit-${comment.id}`">댓글 수정</label>
                <textarea :id="`comment-edit-${comment.id}`" v-model="editDraft" rows="3" :maxlength="BODY_MAX" />
                <div class="actions">
                  <button type="submit" :disabled="busyId === comment.id">저장</button>
                  <button type="button" class="secondary" @click="editingId = null">취소</button>
                </div>
              </form>
              <p v-else class="pre">{{ comment.body }}</p>
            </template>
            <div v-if="editingId !== comment.id && (comment.canEdit || comment.canDelete || comment.canHide)" class="actions">
              <button v-if="comment.canEdit" type="button" class="link-button" @click="startEdit(comment)">수정</button>
              <button v-if="comment.canDelete" type="button" class="link-button" :disabled="busyId === comment.id" @click="remove(comment)">삭제</button>
              <button v-if="comment.canHide" type="button" class="link-button" :disabled="busyId === comment.id" @click="setHidden(comment, comment.status !== 'hidden')">
                {{ comment.status === 'hidden' ? '숨김 풀기' : '숨기기' }}
              </button>
            </div>
          </li>
        </ol>
        <p v-if="status" :class="['notice', status.kind]" :role="status.kind === 'error' ? 'alert' : 'status'">{{ status.text }}</p>
        <form v-if="data.canComment" class="stack" novalidate @submit.prevent="submit">
          <label :for="inputId">피드백 남기기</label>
          <textarea
            :id="inputId"
            v-model="draft"
            rows="2"
            :maxlength="BODY_MAX"
            :aria-invalid="!!draftError"
            :aria-describedby="draftError ? `${inputId}-error` : undefined"
          />
          <p v-if="draftError" :id="`${inputId}-error`" class="field-error" role="alert">{{ draftError }}</p>
          <div class="actions">
            <button type="submit" :disabled="saving">{{ saving ? '남기는 중…' : '댓글 남기기' }}</button>
          </div>
        </form>
        <p v-else-if="data.archived" class="muted small">보관된 과제라 댓글은 읽기만 할 수 있습니다.</p>
        <p v-else class="muted small">읽기 전용 멤버는 댓글을 읽기만 할 수 있습니다.</p>
      </template>
    </section>
  </div>
</template>
