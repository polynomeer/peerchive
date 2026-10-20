<script setup lang="ts">
/**
 * 타임라인의 로그 한 건: 태그(텍스트 라벨)·작성자·수행일(자기 기입)/기록 시각·구조화 필드·링크·막힘↔해결 연결,
 * 사후 작성 표시·출처 할 일(T-07), 수정 이력(rN)과 작성자용 수정 폼. 수정은 expectedRevision을 보내고 409면 최신 내용을 다시 불러옵니다.
 */
import type {
  DecisionPayload,
  LogDto,
  LogRevisionDto,
  MeetingPayload,
  MemberDto,
  MilestoneDto,
  SolutionPayload,
  StuckPayload,
  ValidationPayload,
} from '~~/shared/types/api'
import type { EvidenceOption } from '~/utils/artifacts'

const props = defineProps<{
  log: LogDto
  members: MemberDto[]
  stuckLogs: LogDto[]
  evidenceOptions: EvidenceOption[]
  milestones: MilestoneDto[]
}>()
const emit = defineEmits<{ updated: [log: LogDto] }>()

const headingId = computed(() => `log-${props.log.id}-heading`)
const memberName = (userId: string) => {
  const m = props.members.find((member) => member.userId === userId)
  return m ? m.displayName || m.handle || '이름 미설정' : '이전 멤버'
}

const stuck = computed(() => (props.log.tag === 'stuck' ? (props.log.payload as StuckPayload) : null))
const solution = computed(() => (props.log.tag === 'solution' ? (props.log.payload as SolutionPayload) : null))
const decision = computed(() => (props.log.tag === 'decision' ? (props.log.payload as DecisionPayload) : null))
const validation = computed(() => (props.log.tag === 'validation' ? (props.log.payload as ValidationPayload) : null))
const meeting = computed(() => (props.log.tag === 'meeting' ? (props.log.payload as MeetingPayload) : null))

// ── 수정 이력 ──
const historyOpen = ref(false)
const history = ref<LogRevisionDto[] | null>(null)
const historyError = ref(false)
async function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (!historyOpen.value) return
  historyError.value = false
  try {
    history.value = await $fetch<LogRevisionDto[]>(`/api/v1/logs/${props.log.id}/revisions`)
  } catch {
    historyError.value = true
  }
}

// ── 수정 ──
const editing = ref(false)
const form = reactive(emptyLogForm(props.log.tag))
const baseRevision = ref(props.log.revisionNo)
const errors = ref<Record<string, string>>({})
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const saving = ref(false)

function startEdit() {
  Object.assign(form, logToForm(props.log))
  baseRevision.value = props.log.revisionNo
  errors.value = {}
  status.value = null
  editing.value = true
}

async function saveEdit() {
  errors.value = {}
  saving.value = true
  status.value = null
  try {
    const updated = await $fetch<LogDto>(`/api/v1/logs/${props.log.id}/revisions`, {
      method: 'POST',
      body: { ...formRequest(form), expectedRevision: baseRevision.value },
    })
    editing.value = false
    history.value = null
    historyOpen.value = false
    emit('updated', updated)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = formFieldErrors(error.fields)
      status.value = { kind: 'error', text: error.fields._ === 'no_changes' ? '바뀐 내용이 없습니다.' : '입력을 확인하세요.' }
    } else if (error.status === 409) {
      // 입력은 그대로 두고, 화면의 로그를 최신 revision으로 바꿉니다. 다시 저장하면 최신 revision 위에 쌓입니다.
      try {
        const latest = await $fetch<LogDto>(`/api/v1/logs/${props.log.id}`)
        emit('updated', latest)
        baseRevision.value = latest.revisionNo
      } catch {
        // 아래 안내로 충분합니다.
      }
      status.value = {
        kind: 'error',
        text: `다른 곳에서 먼저 수정되어 최신 내용(r${baseRevision.value})을 불러왔습니다. 입력한 내용은 남겨 두었으니 확인한 뒤 다시 저장하세요.`,
      }
    } else {
      status.value = { kind: 'error', text: '저장하지 못했습니다. 입력은 남아 있습니다. 다시 시도하세요.' }
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <article :id="`log-${log.id}`" class="log-item" tabindex="-1" :aria-labelledby="headingId">
    <header class="log-head">
      <h3 :id="headingId" class="log-tag">{{ LOG_TAG_LABELS[log.tag] }}</h3>
      <span>{{ log.author.displayName || log.author.handle || '이름 미설정' }}</span>
      <span class="muted">
        기록 <time :datetime="log.createdAt">{{ formatDateTime(log.createdAt) }}</time>
        <template v-if="log.claimedDate"> · {{ log.retrospective ? '기억·파일 기준 날짜' : '수행일' }}(자기 기입) <time :datetime="log.claimedDate">{{ log.claimedDate }}</time></template>
      </span>
      <span v-if="log.retrospective" class="badge retro">사후 작성</span>
      <span v-if="log.revisionNo > 1" class="badge">수정됨 (r{{ log.revisionNo }})</span>
    </header>
    <p v-if="log.task" class="relation small">↳ 할 일에서 남김: {{ log.task.title }}</p>

    <p v-if="log.tag === 'solution' && log.resolves" class="relation">
      ↳ 막힘 연결됨: {{ log.resolves.summary || '증상 없음' }} <span class="muted">({{ log.resolves.author.displayName }})</span>
    </p>
    <div v-if="log.tag === 'stuck'" class="relation">
      <template v-if="log.resolvedBy.length > 0">
        <span class="badge resolved">해결됨 ({{ log.resolvedBy.length }})</span>
        <ul class="plain-inline">
          <li v-for="ref in log.resolvedBy" :key="ref.id">💡 {{ ref.summary || '해결' }} <span class="muted">({{ ref.author.displayName }})</span></li>
        </ul>
      </template>
      <span v-else class="badge">미해결</span>
    </div>

    <dl v-if="stuck" class="log-fields">
      <dt>증상</dt>
      <dd>{{ stuck.symptom }}</dd>
      <template v-if="stuck.keywords.length">
        <dt>키워드</dt>
        <dd>{{ stuck.keywords.join(', ') }}</dd>
      </template>
      <template v-if="stuck.errorText">
        <dt>오류 메시지</dt>
        <dd><pre class="mono">{{ stuck.errorText }}</pre></dd>
      </template>
      <template v-if="stuck.attempts.length">
        <dt>시도한 것</dt>
        <dd><ul><li v-for="(a, i) in stuck.attempts" :key="i">{{ a }}</li></ul></dd>
      </template>
      <dt>걸린 시간</dt>
      <dd>{{ TIME_BUCKET_LABELS[stuck.timeBucket] }}</dd>
    </dl>
    <dl v-else-if="solution" class="log-fields">
      <dt>해결 방법</dt>
      <dd class="pre">{{ solution.method }}</dd>
      <template v-if="solution.timeBucket">
        <dt>걸린 시간</dt>
        <dd>{{ TIME_BUCKET_LABELS[solution.timeBucket] }}</dd>
      </template>
    </dl>
    <dl v-else-if="decision" class="log-fields">
      <dt>선택지</dt>
      <dd>{{ decision.options.join(' / ') }}</dd>
      <dt>판단 기준</dt>
      <dd class="pre">{{ decision.criteria }}</dd>
      <dt>선택</dt>
      <dd>{{ decision.choice }}</dd>
      <template v-if="decision.hindsight">
        <dt>지나고 보니</dt>
        <dd class="pre">{{ decision.hindsight }}</dd>
      </template>
    </dl>
    <dl v-else-if="validation" class="log-fields">
      <dt>대상</dt>
      <dd class="pre">{{ validation.target }}</dd>
      <dt>조건</dt>
      <dd class="pre">{{ validation.conditions }}</dd>
      <dt>결과</dt>
      <dd class="pre">{{ validation.result }}</dd>
      <template v-if="validation.openQuestions">
        <dt>남은 불확실성</dt>
        <dd class="pre">{{ validation.openQuestions }}</dd>
      </template>
    </dl>
    <dl v-else-if="meeting" class="log-fields">
      <template v-if="meeting.attendees.length">
        <dt>참석자</dt>
        <dd>{{ meeting.attendees.map(memberName).join(', ') }}</dd>
      </template>
      <template v-if="meeting.decisions.length">
        <dt>결정</dt>
        <dd><ul><li v-for="(d, i) in meeting.decisions" :key="i">{{ d }}</li></ul></dd>
      </template>
      <template v-if="meeting.followUps.length">
        <dt>후속 할 일</dt>
        <dd><ul><li v-for="(f, i) in meeting.followUps" :key="i">{{ f }}</li></ul></dd>
      </template>
    </dl>

    <p v-if="log.body" class="pre">{{ log.body }}</p>

    <ul v-if="log.links.length" class="log-links" aria-label="근거 링크">
      <li v-for="(link, i) in log.links" :key="i">
        🔗 <a :href="link.url" target="_blank" rel="noopener noreferrer nofollow ugc">{{ link.title || link.url }}</a>
      </li>
    </ul>

    <ul v-if="log.evidence.length" class="log-links" aria-label="파일 근거">
      <li v-for="file in log.evidence" :key="file.versionId">
        📎
        <a v-if="file.contentUrl" :href="file.contentUrl" target="_blank" rel="noopener">{{ file.title }} v{{ file.versionNo }}</a>
        <span v-else>{{ file.title }} v{{ file.versionNo }}</span>
        <span class="muted"> — {{ SCAN_STATUS_LABELS[file.scanStatus] }}</span>
      </li>
    </ul>

    <div class="actions">
      <button v-if="log.revisionNo > 1" type="button" class="link-button" :aria-expanded="historyOpen" @click="toggleHistory">
        {{ historyOpen ? '수정 이력 닫기' : `수정 이력 보기 (${log.revisionNo}개)` }}
      </button>
      <button v-if="log.canRevise && !editing" type="button" class="secondary" @click="startEdit">수정</button>
    </div>

    <div v-if="historyOpen" class="history">
      <p v-if="historyError" class="field-error" role="alert">이력을 불러오지 못했습니다.</p>
      <p v-else-if="!history" class="muted" role="status">불러오는 중…</p>
      <ol v-else class="plain">
        <li v-for="rev in history" :key="rev.revisionNo">
          <strong>r{{ rev.revisionNo }}</strong>
          <span class="muted"> · 기록 <time :datetime="rev.recordedAt">{{ formatDateTime(rev.recordedAt) }}</time>
            <template v-if="rev.claimedDate"> · 수행일(자기 기입) {{ rev.claimedDate }}</template></span>
          <p v-if="rev.body" class="pre">{{ rev.body }}</p>
          <ul v-if="Object.keys(rev.payload).length" class="small">
            <li v-for="(line, i) in payloadLines(rev.payload)" :key="i">{{ line }}</li>
          </ul>
          <p v-if="rev.links.length" class="small muted">링크 {{ rev.links.length }}개: {{ rev.links.map((l) => l.url).join(', ') }}</p>
          <p v-if="rev.evidenceVersionIds.length" class="small muted">파일 근거 {{ rev.evidenceVersionIds.length }}개</p>
        </li>
      </ol>
    </div>

    <form v-if="editing" class="stack edit-form" novalidate @submit.prevent="saveEdit">
      <p class="hint">태그({{ LOG_TAG_LABELS[log.tag] }})는 바꿀 수 없습니다. 저장하면 새 버전(r{{ baseRevision + 1 }})이 생기고 이전 내용은 이력에 남습니다.</p>
      <LogFields
        :form="form"
        :id-prefix="`edit-${log.id}`"
        :errors="errors"
        :members="members"
        :stuck-logs="stuckLogs"
        :evidence-options="evidenceOptions"
        :milestones="milestones"
        :retro="log.retrospective"
      />
      <p v-if="status" :class="['notice', status.kind]" :role="status.kind === 'error' ? 'alert' : 'status'">{{ status.text }}</p>
      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : '새 버전 저장' }}</button>
        <button type="button" class="secondary" @click="editing = false">취소</button>
      </div>
    </form>
  </article>
</template>
