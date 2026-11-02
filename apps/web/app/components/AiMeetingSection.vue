<script setup lang="ts">
/**
 * AI 회의 요약(E-13, PROOFU_EVOLUTION_PLAN §6.5, ADR 0058). 서버에 AI가 설정되어 있을 때만 과제 화면에 보입니다(features.ai).
 * - owner가 연결된 디스코드 채널을 회의 채널로 제안하고, 팀원 전원이 여기서 동의해야 디스코드 `/summarize`가 동작합니다.
 *   누구든 철회하면 즉시 멈추고, 새 멤버가 들어오면 그 사람이 동의할 때까지 멈춥니다.
 * - 초안(요약·결정·후속 할 일)은 팀원이 봅니다. owner/editor가 고쳐서 승인하면 🗣️ 회의 로그(`AI 초안`)가 되고, 고른 후속 할 일은 할 일이 됩니다.
 *   요청한 사람은 다른 owner/editor가 있으면 직접 승인하지 못합니다(두 사람 확인).
 */
import type { AiMeetingApproveDto, AiMeetingDraftDto, AiMeetingStateDto, MemberDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; members: MemberDto[] }>()

const base = `/api/v1/projects/${props.projectId}/ai-meetings`
const state = ref<AiMeetingStateDto | null>(null)
const loadError = ref(false)
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const logsChanged = useLogsChanged(props.projectId)

interface DraftForm {
  body: string
  decisions: string
  followUps: string
  attendees: string[]
  /** 후속 할 일 → 할 일로 만들지(초안 항목 순서). */
  tasks: Array<{ create: boolean; title: string; assigneeId: string | null; dueAt: string | null }>
}
const forms = reactive<Record<string, DraftForm>>({})
const errors = reactive<Record<string, string>>({})

function toForm(draft: AiMeetingDraftDto): DraftForm {
  return {
    body: draft.logInput.body,
    decisions: draft.logInput.payload.decisions.join('\n'),
    followUps: draft.logInput.payload.followUps.join('\n'),
    attendees: [...draft.logInput.payload.attendees],
    tasks: draft.followUps.map((f) => ({ create: false, title: f.text.slice(0, 120), assigneeId: f.ownerId, dueAt: f.due })),
  }
}

function apply(next: AiMeetingStateDto) {
  state.value = next
  for (const draft of next.drafts) forms[draft.id] ??= toForm(draft)
  for (const id of Object.keys(forms)) if (!next.drafts.some((d) => d.id === id)) delete forms[id]
}

async function load() {
  try {
    apply(await $fetch<AiMeetingStateDto>(base))
    loadError.value = false
  } catch {
    loadError.value = true
  }
}
onMounted(load)

function errorText(status: number, code: string): string {
  if (status === 403 && code === 'second_approver_required') return '요약을 요청한 사람이 아닌 다른 팀원(운영 책임자·편집자)이 승인해야 합니다.'
  if (status === 403) return '권한이 없습니다.'
  if (status === 404) return '찾을 수 없습니다. 이미 처리됐거나 7일이 지나 지워졌을 수 있습니다.'
  if (status === 422) return '입력을 확인하세요. 내용은 그대로 남아 있습니다.'
  return '처리하지 못했습니다. 다시 시도하세요.'
}

async function run(action: () => Promise<AiMeetingStateDto>, ok: string) {
  busy.value = true
  notice.value = null
  try {
    apply(await action())
    notice.value = { kind: 'ok', text: ok }
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: errorText(err.status, err.code) }
    if (err.status === 404) await load()
  } finally {
    busy.value = false
  }
}

const propose = (bindingId: string, enabled: boolean) => {
  if (!enabled && !confirm('회의 채널 지정을 거둘까요? 팀원들의 동의와 승인하지 않은 요약 초안이 지워집니다.')) return
  void run(
    () => $fetch<AiMeetingStateDto>(`${base}/channels/${bindingId}`, { method: 'PUT', body: { enabled } }),
    enabled ? '회의 채널로 제안했습니다. 팀원 전원이 동의하면 요약할 수 있습니다.' : '회의 채널 지정을 거뒀습니다.',
  )
}
const consent = (bindingId: string, agree: boolean) => {
  if (!agree && !confirm('동의를 철회할까요? 이 채널은 바로 요약할 수 없게 되고, 승인하지 않은 요약 초안도 지워집니다.')) return
  void run(
    () => $fetch<AiMeetingStateDto>(`${base}/channels/${bindingId}/consent`, { method: 'PUT', body: { agree } }),
    agree ? '동의했습니다.' : '동의를 철회했습니다.',
  )
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

async function approve(draftId: string) {
  const form = forms[draftId]
  if (!form || busy.value) return
  busy.value = true
  notice.value = null
  delete errors[draftId]
  try {
    const res = await $fetch<AiMeetingApproveDto>(`${base}/drafts/${draftId}/approve`, {
      method: 'POST',
      body: {
        body: form.body,
        payload: { attendees: form.attendees, decisions: lines(form.decisions), followUps: lines(form.followUps) },
        tasks: form.tasks.filter((t) => t.create).map(({ title, assigneeId, dueAt }) => ({ title, assigneeId, dueAt })),
      },
    })
    apply(res.state)
    logsChanged.notify()
    notice.value = { kind: 'ok', text: `🗣️ 회의 로그로 저장했습니다(AI 초안 표시)${res.tasks.length ? `. 할 일 ${res.tasks.length}개를 만들었습니다` : ''}.` }
  } catch (e) {
    const err = apiError(e)
    errors[draftId] = errorText(err.status, err.code) + (Object.keys(err.fields).length ? ` (${Object.keys(err.fields).join(', ')})` : '')
    if (err.status === 404) await load()
  } finally {
    busy.value = false
  }
}
const reject = (draftId: string) => {
  if (!confirm('이 요약 초안을 거절할까요? 아무것도 저장하지 않고 지웁니다.')) return
  void run(() => $fetch<AiMeetingStateDto>(`${base}/drafts/${draftId}`, { method: 'DELETE' }), '초안을 거절했습니다.')
}

const channelName = (label: string | null, channelId: string) => label || `채널 …${channelId.slice(-4)}`
const formatTime = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const activeMembers = computed(() => props.members)
</script>

<template>
  <section id="ai-meeting" class="card" aria-labelledby="ai-meeting-heading" data-testid="ai-meeting-section">
    <h2 id="ai-meeting-heading">AI 회의 요약 (선택)</h2>
    <p class="hint">
      팀원 전원이 동의한 디스코드 회의 채널에서 <code>/summarize</code>를 실행하면 AI가 최근 대화를 🗣️ 회의 로그 초안(결정·후속 할 일)으로 정리합니다.
      대화 원문은 저장하지 않고, 초안은 팀원이 승인해야 기록됩니다.
    </p>

    <p v-if="loadError" class="notice error" role="alert">
      불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>

    <template v-else-if="state">
      <details>
        <summary>무엇을 보내고 얼마나 두나요?</summary>
        <ul>
          <li>AI(Anthropic Claude API)에 보내는 것: 고른 시간 범위(최대 24시간)의 최근 메시지 최대 200개의 본문과 회의 날짜. 사람은 [M1] 같은 표지로만 보내고 디스코드 이름·계정 id는 보내지 않습니다. 첨부 파일과 봇 메시지는 보내지 않습니다.</li>
          <li>저장하는 것: AI가 만든 요약·결정·후속 할 일·열린 질문 초안뿐입니다. 대화 원문은 서버 어디에도 저장하지 않습니다.</li>
          <li>초안은 승인·거절하거나 7일이 지나면 지웁니다. 누구든 동의를 철회하면 그 채널의 승인 전 초안도 지웁니다.</li>
          <li>디스코드 계정을 연결하고 동의한 팀원의 메시지만 보냅니다. 팀원이 아닌 사람(또는 계정을 연결하지 않은 팀원)의 메시지는 보내지 않고 "팀 밖 참여자 메시지 N개 제외"로 개수만 남깁니다. 팀원 메시지 속 팀 밖 사람의 멘션은 누구인지 구분하지 않는 "외부"로 바뀝니다.</li>
        </ul>
      </details>

      <p v-if="state.channels.length === 0" class="muted">연결된 디스코드 채널이 없습니다. 아래 디스코드 연결에서 먼저 채널을 연결하세요.</p>
      <ul v-else class="plain">
        <li v-for="c in state.channels" :key="c.bindingId" class="stack">
          <div class="row">
            <span>
              {{ channelName(c.label, c.channelId) }}
              <span class="muted"> · {{ c.meeting ? (c.meeting.allAgreed ? '요약 가능(전원 동의)' : '동의 대기') : '회의 채널 아님' }}</span>
            </span>
            <span class="actions">
              <button v-if="state.canPropose && !c.meeting" type="button" class="secondary" :disabled="busy" @click="propose(c.bindingId, true)">회의 채널로 제안</button>
              <button v-if="state.canPropose && c.meeting" type="button" class="link-button" :disabled="busy" @click="propose(c.bindingId, false)">제안 거두기</button>
              <button v-if="c.meeting && !c.meeting.myConsent" type="button" :disabled="busy" @click="consent(c.bindingId, true)">요약에 동의</button>
              <button v-if="c.meeting && c.meeting.myConsent" type="button" class="secondary" :disabled="busy" @click="consent(c.bindingId, false)">동의 철회</button>
            </span>
          </div>
          <p v-if="c.meeting" class="hint">
            동의: <span v-for="(m, i) in c.meeting.members" :key="m.userId">{{ i ? ', ' : '' }}{{ m.displayName }} {{ m.agreed ? '✓' : '(대기)' }}</span>
          </p>
        </li>
      </ul>

      <template v-if="state.drafts.length">
        <h3>승인 대기 초안</h3>
        <form
          v-for="draft in state.drafts"
          :key="draft.id"
          class="stack composer"
          novalidate
          :aria-label="`회의 요약 초안 ${formatTime(draft.createdAt)}`"
          @submit.prevent="approve(draft.id)"
        >
          <p class="log-tag">
            🗣️ 회의 <span class="badge">AI 초안</span>
            <span class="muted small">
              {{ channelName(draft.channelLabel, '') }} · {{ formatTime(draft.windowStart) }}~{{ formatTime(draft.windowEnd) }} · 메시지 {{ draft.messageCount }}개 · 요청 {{ draft.requestedBy.displayName }}
            </span>
          </p>
          <template v-if="forms[draft.id]">
            <label :for="`mt-body-${draft.id}`">요약</label>
            <textarea :id="`mt-body-${draft.id}`" v-model="forms[draft.id]!.body" maxlength="5000" :readonly="!draft.canApprove" />
            <fieldset>
              <legend>참석자</legend>
              <label v-for="m in activeMembers" :key="m.userId" class="inline">
                <input v-model="forms[draft.id]!.attendees" type="checkbox" :value="m.userId" :disabled="!draft.canApprove" /> {{ m.displayName }}
              </label>
            </fieldset>
            <label :for="`mt-dec-${draft.id}`">결정 (한 줄에 하나)</label>
            <textarea :id="`mt-dec-${draft.id}`" v-model="forms[draft.id]!.decisions" :readonly="!draft.canApprove" />
            <label :for="`mt-fu-${draft.id}`">후속 할 일 (한 줄에 하나)</label>
            <textarea :id="`mt-fu-${draft.id}`" v-model="forms[draft.id]!.followUps" :readonly="!draft.canApprove" />
            <fieldset v-if="draft.canApprove && forms[draft.id]!.tasks.length">
              <legend>승인할 때 할 일로도 만들기</legend>
              <label v-for="(t, i) in forms[draft.id]!.tasks" :key="i" class="inline">
                <input v-model="t.create" type="checkbox" /> {{ t.title }}
                <span class="muted small">{{ draft.followUps[i]?.ownerName ? `· ${draft.followUps[i]!.ownerName}` : '' }}{{ t.dueAt ? ` · ${t.dueAt}` : '' }}</span>
              </label>
            </fieldset>
          </template>
          <p v-if="errors[draft.id]" class="notice error" role="alert">{{ errors[draft.id] }}</p>
          <div class="actions">
            <button v-if="draft.canApprove" type="submit" :disabled="busy">승인해서 회의 로그로 저장</button>
            <span v-else-if="draft.canReject" class="hint">요약을 요청한 사람이 아닌 다른 팀원이 승인합니다.</span>
            <button v-if="draft.canReject" type="button" class="secondary" :disabled="busy" @click="reject(draft.id)">거절</button>
          </div>
        </form>
      </template>

      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    </template>
  </section>
</template>
