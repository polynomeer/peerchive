<script setup lang="ts">
/**
 * 운영 조치 안내 + 이의제기(T-15, ADR 0015). 당사자 화면(공개 준비·선배 노트·케이스 스터디·내 알림)에서 씁니다.
 * 당사자용 사유(public_reason)와 이의 상태만 보여 줍니다(운영자 내부 메모·신고 내용·신고자는 서버가 싣지 않음).
 * 이의제기는 조치마다 한 번이고 운영자가 유지하거나 되돌립니다.
 */
import type { AppealDto, ModerationNoticeDto } from '~~/shared/types/api'

const props = defineProps<{ notice: ModerationNoticeDto; idPrefix: string; showTarget?: boolean }>()
const emit = defineEmits<{ appealed: [] }>()

const open = ref(false)
const message = ref('')
const busy = ref(false)
const error = ref('')
const sent = ref(false)

async function submit() {
  error.value = ''
  if (!message.value.trim()) {
    error.value = '이의 내용을 적어 주세요.'
    return
  }
  busy.value = true
  try {
    await $fetch<AppealDto>('/api/v1/appeals', { method: 'POST', body: { actionId: props.notice.actionId, message: message.value } })
    sent.value = true
    open.value = false
    emit('appealed')
  } catch (e) {
    error.value = moderationErrorMessage(apiError(e).code)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="notice moderation-notice" :class="{ error: !notice.reversedAt }" role="status">
    <p>
      <strong>{{ NOTICE_TITLES[notice.kind] }}</strong>
      <span v-if="notice.reversedAt" class="badge">풀림 · {{ formatDateTime(notice.reversedAt) }}</span>
      <span class="small muted"> · {{ formatDateTime(notice.createdAt) }}</span>
    </p>
    <p v-if="showTarget" class="small">대상: {{ notice.targetLabel }}<template v-if="notice.ownerPath"> · <NuxtLink :to="notice.ownerPath">내 화면에서 보기</NuxtLink></template></p>
    <p v-if="notice.item" class="small">가려진 항목: {{ notice.item.label }}</p>
    <p class="small">사유: {{ notice.publicReason ?? '운영 정책에 따라 공개를 막았습니다.' }}</p>
    <p v-if="notice.kind === 'restrict' && !notice.reversedAt" class="hint">
      공개 페이지는 열리지 않습니다. 조치가 풀리면 새 공개 후보를 만들고 팀원 동의를 다시 받아 게시해야 합니다.
    </p>
    <p v-if="notice.appeal" class="small">{{ APPEAL_STATUS_LABELS[notice.appeal.status] }} · {{ formatDateTime(notice.appeal.createdAt) }}</p>
    <p v-else-if="sent" class="small">이의제기를 보냈습니다. 운영자가 검토합니다.</p>
    <template v-else-if="notice.canAppeal">
      <p v-if="!open"><button type="button" class="secondary small" @click="open = true">이의제기</button></p>
      <form v-else class="stack" @submit.prevent="submit">
        <div class="field">
          <label :for="`${idPrefix}-appeal`">이의 내용(조치마다 한 번)</label>
          <textarea :id="`${idPrefix}-appeal`" v-model="message" rows="3" maxlength="1000" :aria-describedby="`${idPrefix}-appeal-hint`" />
          <p :id="`${idPrefix}-appeal-hint`" class="hint">{{ message.length }}/1000자. 운영자가 읽고 조치를 유지하거나 풉니다.</p>
        </div>
        <p v-if="error" class="field-error" role="alert">{{ error }}</p>
        <p class="actions">
          <button type="submit" :disabled="busy">이의제기 보내기</button>
          <button type="button" class="secondary" @click="open = false">취소</button>
        </p>
      </form>
    </template>
  </div>
</template>
