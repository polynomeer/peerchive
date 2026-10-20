<script setup lang="ts">
/**
 * 역할 선언 폼(T-08): "내가 맡은 것"을 한 문장으로 적고, 이 과제의 빌드 로그·파일을 근거로 고릅니다.
 * - 새 선언(claim 없음)과 수정(claim 있음)이 함께 씁니다. 수정은 항상 새 버전이며, 저장 전에 "받은 확인이 새 버전에
 *   이어지지 않는다"는 안내를 버튼 바로 위에 글로 보여 줍니다(버튼의 aria-describedby로도 연결).
 * - 근거 후보: 이 과제의 로그(최근 200개, 제목·태그로 거르기)와 파일 버전(사용 가능·검사 중만, 격리·실패는 고를 수 없음).
 */
import type { ClaimDto, LogDto, LogPageDto, LogTag } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; idPrefix: string; claim?: ClaimDto | null }>()
const emit = defineEmits<{ saved: [claim: ClaimDto]; cancel: [] }>()

const id = (name: string) => `${props.idPrefix}-${name}`
const editing = computed(() => !!props.claim)

const text = ref(props.claim?.text ?? '')
const logIds = ref<string[]>(props.claim?.evidence.flatMap((e) => (e.kind === 'log' ? [e.logId] : [])) ?? [])
const versionIds = ref<string[]>(props.claim?.evidence.flatMap((e) => (e.kind === 'artifact' ? [e.versionId] : [])) ?? [])
const selectedCount = computed(() => logIds.value.length + versionIds.value.length)
const errors = ref<Record<string, string>>({})
const failure = ref<string | null>(null)
const saving = ref(false)

// ── 근거 후보 ──
const logs = ref<LogDto[]>([])
const logsLoaded = ref(false)
const logsError = ref(false)
const LOG_PAGES = 4
async function loadLogs() {
  try {
    const all: LogDto[] = []
    let cursor: string | null = null
    for (let page = 0; page < LOG_PAGES; page++) {
      const query: Record<string, string | number> = { limit: 50 }
      if (cursor) query.cursor = cursor
      const result: LogPageDto = await $fetch<LogPageDto>(`/api/v1/projects/${props.projectId}/logs`, { query })
      all.push(...result.items)
      cursor = result.nextCursor
      if (!cursor) break
    }
    logs.value = all
    logsError.value = false
  } catch {
    logsError.value = true
  } finally {
    logsLoaded.value = true
  }
}

const artifacts = useProjectArtifacts(props.projectId)
const fileChoices = computed(() =>
  evidenceOptions(artifacts.items.value).filter(
    (option) => option.scanStatus === 'clean' || isScanInProgress(option.scanStatus) || versionIds.value.includes(option.versionId),
  ),
)

const logQuery = ref('')
const logTag = ref<LogTag | ''>('')
const logChoices = computed(() => {
  const q = logQuery.value.trim().toLowerCase()
  return logs.value.filter((log) => {
    if (logIds.value.includes(log.id)) return true
    if (logTag.value && log.tag !== logTag.value) return false
    return !q || logSummary(log).toLowerCase().includes(q) || log.author.displayName.toLowerCase().includes(q)
  })
})
const full = computed(() => selectedCount.value >= CLAIM_EVIDENCE_MAX)

onMounted(() => {
  void loadLogs()
  if (!artifacts.loaded.value) void artifacts.refresh()
})

const endorsementCount = computed(() => (props.claim ? props.claim.confirmedCount + props.claim.disputedCount : 0))

async function save() {
  saving.value = true
  errors.value = {}
  failure.value = null
  const evidence = [
    ...logIds.value.map((logId) => ({ kind: 'log' as const, id: logId })),
    ...versionIds.value.map((versionId) => ({ kind: 'artifact' as const, id: versionId })),
  ]
  try {
    const saved = props.claim
      ? await $fetch<ClaimDto>(`/api/v1/claims/${props.claim.id}/revisions`, {
          method: 'POST',
          body: { expectedRevision: props.claim.revisionNo, text: text.value, evidence },
        })
      : await $fetch<ClaimDto>(`/api/v1/projects/${props.projectId}/claims`, { method: 'POST', body: { text: text.value, evidence } })
    if (!props.claim) {
      text.value = ''
      logIds.value = []
      versionIds.value = []
    }
    emit('saved', saved)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = error.fields
      if (error.fields._ === 'no_changes') failure.value = '바뀐 내용이 없습니다.'
    } else {
      failure.value = claimErrorMessage(error.code, '저장하지 못했습니다. 입력한 내용은 그대로 두었으니 다시 시도하세요.')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="stack claim-form" novalidate @submit.prevent="save">
    <div class="field">
      <label :for="id('text')">{{ editing ? '선언 고치기' : '내가 맡은 것' }} ({{ CLAIM_TEXT_MAX }}자 이내)</label>
      <textarea
        :id="id('text')"
        v-model="text"
        :maxlength="CLAIM_TEXT_MAX"
        rows="2"
        placeholder="예: 로그인·회원가입 API와 입력 검증을 맡았다"
        :aria-invalid="errors.text ? 'true' : undefined"
        :aria-describedby="[id('text-hint'), errors.text ? id('text-error') : ''].filter(Boolean).join(' ')"
      />
      <p :id="id('text-hint')" class="hint">비율이나 점수 대신, 맡은 일을 사실대로 한 문장으로 적으세요. {{ text.length }}/{{ CLAIM_TEXT_MAX }}자</p>
      <p v-if="errors.text" :id="id('text-error')" class="field-error">{{ fieldMessage(errors.text) }}</p>
    </div>

    <fieldset :aria-describedby="[id('evidence-hint'), errors.evidence ? id('evidence-error') : ''].filter(Boolean).join(' ')">
      <legend>근거 (선택, 로그·파일 합쳐 {{ CLAIM_EVIDENCE_MAX }}개까지 · {{ selectedCount }}개 고름)</legend>
      <p :id="id('evidence-hint')" class="hint">
        근거가 있으면 팀원이 확인하기 쉽습니다. 로그는 지금 내용으로 고정되고, 검사 중인 파일은 “검사 중”으로 표시됩니다.
      </p>
      <p v-if="errors.evidence" :id="id('evidence-error')" class="field-error">
        {{ errors.evidence === 'not_attachable' ? fieldMessage('not_attachable') : '고른 근거 중 이 과제에서 찾을 수 없는 것이 있습니다.' }}
      </p>

      <h4 class="claim-evidence-heading">빌드 로그</h4>
      <div class="actions claim-log-filter">
        <label :for="id('log-query')" class="visually-hidden">로그 검색</label>
        <input :id="id('log-query')" v-model="logQuery" type="search" placeholder="제목·작성자로 찾기" />
        <label :for="id('log-tag')" class="visually-hidden">태그</label>
        <select :id="id('log-tag')" v-model="logTag">
          <option value="">모든 태그</option>
          <option v-for="tag in LOG_TAG_ORDER" :key="tag" :value="tag">{{ LOG_TAG_LABELS[tag] }}</option>
        </select>
      </div>
      <p v-if="logsError" class="field-error">로그를 불러오지 못했습니다. <button type="button" class="link-button" @click="loadLogs">다시 시도</button></p>
      <p v-else-if="logsLoaded && logs.length === 0" class="muted">아직 빌드 로그가 없습니다.</p>
      <p v-else-if="logsLoaded && logChoices.length === 0" class="muted">조건에 맞는 로그가 없습니다.</p>
      <div v-if="logChoices.length" class="claim-evidence-list" role="group" :aria-label="'빌드 로그 근거'">
        <label v-for="log in logChoices" :key="log.id" class="check">
          <input v-model="logIds" type="checkbox" :value="log.id" :disabled="full && !logIds.includes(log.id)" />
          <span>{{ LOG_TAG_LABELS[log.tag] }} · {{ logSummary(log) || '내용 없음' }} <span class="muted">({{ log.author.displayName || '이름 미설정' }})</span></span>
        </label>
      </div>

      <h4 class="claim-evidence-heading">파일</h4>
      <p v-if="artifacts.loaded.value && fileChoices.length === 0" class="muted">근거로 고를 수 있는 파일이 없습니다(산출물 섹션에서 올릴 수 있습니다).</p>
      <div v-else class="claim-evidence-list" role="group" aria-label="파일 근거">
        <label v-for="option in fileChoices" :key="option.versionId" class="check">
          <input
            v-model="versionIds"
            type="checkbox"
            :value="option.versionId"
            :disabled="!versionIds.includes(option.versionId) && (full || option.scanStatus === 'quarantined' || option.scanStatus === 'failed')"
          />
          <span>{{ option.label }} <span class="muted">· {{ SCAN_STATUS_LABELS[option.scanStatus] }}</span></span>
        </label>
      </div>
    </fieldset>

    <p v-if="editing" :id="id('reset-warning')" class="notice claim-reset-warning">
      저장하면 이 선언의 새 버전이 만들어집니다.
      <strong v-if="endorsementCount > 0">지금까지 받은 팀원 확인·이의 {{ endorsementCount }}건은 새 버전에 이어지지 않고,</strong>
      <template v-else>팀원 확인은</template>
      새 버전은 “본인 설명 · 미확인”에서 다시 시작합니다. 이전 버전과 그 확인은 수정 이력에 남습니다.
    </p>
    <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    <div class="actions">
      <button type="submit" :disabled="saving" :aria-describedby="editing ? id('reset-warning') : undefined">
        {{ saving ? '저장 중…' : editing ? '새 버전으로 저장' : '선언하기' }}
      </button>
      <button v-if="editing" type="button" class="secondary" @click="emit('cancel')">취소</button>
    </div>
  </form>
</template>
