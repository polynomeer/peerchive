<script setup lang="ts">
/**
 * 운영자 작성자 확인 + 이용 제한 발급(C-06, ADR 0023). 사유를 적어야 확인할 수 있고, 확인할 때마다 조회 기록(사유)과 감사(id만)가 남습니다.
 * 확인 결과(작성자 내부 id·핸들·계정 상태·제재 이력)는 이 화면의 이 응답에만 있고 저장된 목록 어디에도 다시 나오지 않습니다.
 * 제재는 이 확인으로만(같은 운영자, 24시간 안) 발급합니다. 경고는 알림만, 쓰기 기간 제한은 일수, 영구 제한은 커뮤니티 전체만.
 */
import type { AuthorLookupResultDto, OperatorSanctionDto, SanctionLevel, SanctionScope } from '~~/shared/types/api'

const props = defineProps<{ targetType: 'post' | 'comment'; targetId: string; reportId?: string | null; requestId?: string | null; idPrefix: string }>()
const emit = defineEmits<{ issued: [OperatorSanctionDto] }>()

const reason = ref('')
const result = ref<AuthorLookupResultDto | null>(null)
const issued = ref<OperatorSanctionDto | null>(null)
const busy = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const fieldErrors = ref<Record<string, string>>({})
const form = reactive({ level: 'write_suspended' as SanctionLevel, scope: 'space' as SanctionScope, days: 7, note: '', publicReason: '' })

function fail(e: unknown) {
  const err = apiError(e)
  fieldErrors.value = err.fields
  message.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력을 확인하세요.' : moderationErrorMessage(err.code) }
}

async function lookup() {
  message.value = null
  fieldErrors.value = {}
  if (!reason.value.trim()) {
    fieldErrors.value = { reason: 'required' }
    message.value = { kind: 'error', text: '확인 사유를 적어야 합니다.' }
    return
  }
  busy.value = true
  try {
    result.value = await $fetch<AuthorLookupResultDto>('/api/v1/operator/community/author-lookups', {
      method: 'POST',
      body: { targetType: props.targetType, targetId: props.targetId, reason: reason.value, ...(props.reportId ? { reportId: props.reportId } : props.requestId ? { requestId: props.requestId } : {}) },
    })
    reason.value = ''
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function issue() {
  if (!result.value) return
  message.value = null
  fieldErrors.value = {}
  busy.value = true
  try {
    issued.value = await $fetch<OperatorSanctionDto>('/api/v1/operator/community/sanctions', {
      method: 'POST',
      body: {
        lookupId: result.value.lookupId,
        level: form.level,
        scope: form.level === 'permanent' ? 'community' : form.scope,
        days: form.level === 'write_suspended' ? Number(form.days) : null,
        note: form.note,
        publicReason: form.publicReason,
      },
    })
    message.value = { kind: 'ok', text: '이용 제한을 발급했습니다. 당사자에게 사유와 이의제기 안내가 보입니다.' }
    emit('issued', issued.value)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack author-lookup">
    <p v-if="message" :class="['notice', message.kind]" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>
    <form v-if="!result" class="stack" @submit.prevent="lookup">
      <p class="hint">
        익명 작성자 확인은 신고 처리·법적 요청 대응에만 씁니다. 확인할 때마다 사유와 함께 기록되고(조회 기록), 감사 기록에 남습니다. 방장·모더레이터에게는 알리지
        않습니다.
      </p>
      <div class="field">
        <label :for="`${idPrefix}-lookup-reason`">작성자 확인 사유(필수)</label>
        <textarea :id="`${idPrefix}-lookup-reason`" v-model="reason" rows="2" maxlength="1000" required />
        <p v-if="fieldErrors.reason" class="field-error">{{ fieldMessage(fieldErrors.reason) }}</p>
      </div>
      <p class="actions"><button type="submit" class="secondary" :disabled="busy">사유를 기록하고 작성자 확인</button></p>
    </form>
    <template v-else>
      <dl class="small" data-testid="lookup-result">
        <dt>작성자(내부 id)</dt>
        <dd class="mono">{{ result.author.userId }}</dd>
        <dt>핸들</dt>
        <dd>{{ result.author.handle ? `@${result.author.handle}` : '없음' }}</dd>
        <dt>계정</dt>
        <dd>{{ result.author.purged ? '탈퇴 정리됨' : result.author.status }}</dd>
        <dt>제재 이력</dt>
        <dd>
          <template v-if="result.sanctions.length">
            <span v-for="s in result.sanctions" :key="s.id" class="badge">{{ SANCTION_LEVEL_TEXT[s.level] }} · {{ s.active ? '적용 중' : '끝남' }}</span>
          </template>
          <template v-else>없음</template>
        </dd>
      </dl>
      <p class="hint">이 확인으로 {{ formatDateTime(result.validUntil) }}까지 제재를 발급할 수 있습니다(같은 운영자만).</p>
      <p v-if="issued" class="small">발급됨: {{ SANCTION_LEVEL_TEXT[issued.level] }} · {{ SANCTION_SCOPE_TEXT[issued.scope] }}</p>
      <form v-else class="stack" @submit.prevent="issue">
        <div class="field">
          <label :for="`${idPrefix}-level`">수준</label>
          <select :id="`${idPrefix}-level`" v-model="form.level">
            <option value="warning">경고(알림만, 쓰기 그대로)</option>
            <option value="write_suspended">쓰기 기간 제한</option>
            <option value="permanent">커뮤니티 영구 제한</option>
          </select>
        </div>
        <div v-if="form.level !== 'permanent'" class="field">
          <label :for="`${idPrefix}-scope`">범위</label>
          <select :id="`${idPrefix}-scope`" v-model="form.scope">
            <option value="space">이 글·댓글의 공간만(방장에게 누구인지 알리지 않음)</option>
            <option value="community">커뮤니티 전체</option>
          </select>
        </div>
        <div v-if="form.level === 'write_suspended'" class="field">
          <label :for="`${idPrefix}-days`">기간(일, 1~365)</label>
          <input :id="`${idPrefix}-days`" v-model.number="form.days" type="number" min="1" max="365" />
          <p v-if="fieldErrors.days" class="field-error">{{ fieldMessage(fieldErrors.days) }}</p>
        </div>
        <div class="field">
          <label :for="`${idPrefix}-snote`">내부 메모(필수, 운영자만)</label>
          <textarea :id="`${idPrefix}-snote`" v-model="form.note" rows="2" maxlength="1000" required />
        </div>
        <div class="field">
          <label :for="`${idPrefix}-spublic`">당사자에게 보일 사유(필수)</label>
          <input :id="`${idPrefix}-spublic`" v-model="form.publicReason" maxlength="300" required />
        </div>
        <p class="hint">과제 공간·포트폴리오·공개 프로필·과목 허브에는 영향이 없습니다. 당사자는 제재마다 한 번 이의를 제기할 수 있습니다.</p>
        <p class="actions"><button type="submit" :disabled="busy">이용 제한 발급</button></p>
      </form>
    </template>
  </div>
</template>
