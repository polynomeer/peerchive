<script setup lang="ts">
/**
 * 마일스톤 한 건(T-06): 이름·예정일·도달일(자기 기입)·메모·로그 수, 스냅샷 목록과 지정/해제,
 * 순서 이동(▲▼ 버튼, 키보드로 조작 가능)·수정(expectedVersion, 409면 최신 내용을 다시 불러옴)·삭제.
 * 순서 이동과 삭제는 목록 전체가 바뀌므로 상위(MilestonesSection)가 처리합니다.
 * 사후 작성으로 만든 마일스톤·스냅샷은 `사후 작성` 글자 배지로 표시합니다(T-07).
 */
import type { MilestoneDto } from '~~/shared/types/api'
import type { SnapshotOption } from '~/utils/milestones'

const props = defineProps<{
  milestone: MilestoneDto
  index: number
  total: number
  canWrite: boolean
  /** 이 마일스톤에 지정할 수 있는 산출물 버전(격리·실패 제외). */
  snapshotChoices: SnapshotOption[]
  /** 순서 변경 요청 중이면 이동 버튼을 잠시 막습니다. */
  busy: boolean
  /** 사후 작성 모드(T-07): 도달일 칸 이름을 바꿉니다. */
  retro?: boolean
}>()
const emit = defineEmits<{
  move: [delta: -1 | 1]
  remove: []
  updated: [milestone: MilestoneDto]
  reload: []
}>()

const base = computed(() => `ms-${props.milestone.id}`)
const label = computed(() => milestoneLabel(props.milestone))
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

// ── 수정 ──
const editing = ref(false)
const form = reactive({ title: '', note: '', dueAt: '', claimedAt: '' })
const baseVersion = ref(props.milestone.version)
const errors = ref<Record<string, string>>({})
const saving = ref(false)

function startEdit() {
  Object.assign(form, {
    title: props.milestone.title,
    note: props.milestone.note ?? '',
    dueAt: props.milestone.dueAt ?? '',
    claimedAt: props.milestone.claimedAt ?? '',
  })
  baseVersion.value = props.milestone.version
  errors.value = {}
  status.value = null
  editing.value = true
}

async function saveEdit() {
  saving.value = true
  errors.value = {}
  status.value = null
  try {
    const updated = await $fetch<MilestoneDto>(`/api/v1/milestones/${props.milestone.id}`, {
      method: 'PATCH',
      body: {
        expectedVersion: baseVersion.value,
        title: form.title,
        note: form.note || null,
        dueAt: form.dueAt || null,
        claimedAt: form.claimedAt || null,
      },
    })
    editing.value = false
    emit('updated', updated)
    status.value = { kind: 'ok', text: '저장했습니다.' }
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = error.fields
      status.value = { kind: 'error', text: '입력을 확인하세요.' }
    } else if (error.status === 409) {
      // 입력은 남겨 두고 목록을 다시 불러옵니다. 다시 저장하면 최신 version 위에 저장됩니다.
      emit('reload')
      status.value = { kind: 'error', text: milestoneErrorMessage('version_conflict', '') }
    } else {
      status.value = { kind: 'error', text: '저장하지 못했습니다. 입력은 남아 있습니다. 다시 시도하세요.' }
    }
  } finally {
    saving.value = false
  }
}

// 목록을 다시 불러와 version이 바뀌면, 수정 중인 폼의 기준 version도 맞춥니다(입력은 유지).
watch(
  () => props.milestone.version,
  (version) => {
    if (editing.value && status.value?.kind === 'error') baseVersion.value = version
  },
)

// ── 스냅샷 ──
const pick = reactive({ versionId: '', note: '' })
const pickError = ref<string | null>(null)
const adding = ref(false)
const full = computed(() => props.milestone.snapshots.length >= SNAPSHOT_MAX)
const selectable = computed(() => props.snapshotChoices.some((option) => !option.disabledReason))

async function addSnapshot() {
  if (!pick.versionId) {
    pickError.value = '지정할 파일을 고르세요.'
    return
  }
  adding.value = true
  pickError.value = null
  try {
    const updated = await $fetch<MilestoneDto>(`/api/v1/milestones/${props.milestone.id}/snapshots`, {
      method: 'POST',
      body: { artifactVersionId: pick.versionId, note: pick.note || null },
    })
    Object.assign(pick, { versionId: '', note: '' })
    emit('updated', updated)
    status.value = { kind: 'ok', text: '스냅샷을 지정했습니다.' }
  } catch (e) {
    const error = apiError(e)
    pickError.value =
      error.status === 422
        ? (fieldMessage(Object.values(error.fields)[0]) ?? '지정하지 못했습니다.')
        : error.status === 409
          ? error.code === 'limit_reached'
            ? `스냅샷은 마일스톤마다 ${SNAPSHOT_MAX}개까지입니다.`
            : milestoneErrorMessage(error.code, '지정하지 못했습니다.')
          : '지정하지 못했습니다. 다시 시도하세요.'
    if (error.status === 409) emit('reload')
  } finally {
    adding.value = false
  }
}

async function removeSnapshot(versionId: string, title: string) {
  if (!confirm(`${title} 스냅샷을 이 마일스톤에서 뺄까요? 파일 자체는 지워지지 않습니다.`)) return
  try {
    await $fetch(`/api/v1/milestones/${props.milestone.id}/snapshots/${versionId}`, { method: 'DELETE' })
    emit('updated', {
      ...props.milestone,
      snapshots: props.milestone.snapshots
        .filter((s) => s.artifactVersionId !== versionId)
        .map((s, i) => ({ ...s, position: i + 1 })),
    })
    status.value = { kind: 'ok', text: '스냅샷을 뺐습니다.' }
  } catch {
    status.value = { kind: 'error', text: '스냅샷을 빼지 못했습니다.' }
    emit('reload')
  }
}
</script>

<template>
  <article class="milestone-item" :aria-labelledby="`${base}-heading`">
    <header class="log-head">
      <h3 :id="`${base}-heading`" class="log-tag">{{ label }}</h3>
      <span v-if="milestone.retrospective" class="badge retro">사후 작성</span>
      <span class="muted small">
        <template v-if="milestone.dueAt">예정 <time :datetime="milestone.dueAt">{{ formatDay(milestone.dueAt) }}</time> · </template>
        <template v-if="milestone.claimedAt">{{ milestone.retrospective ? '기억·파일 기준 도달' : '도달' }} <time :datetime="milestone.claimedAt">{{ formatDay(milestone.claimedAt) }}</time>(자기 기입) · </template>
        로그 {{ milestone.logCount }}개 · 스냅샷 {{ milestone.snapshots.length }}/{{ SNAPSHOT_MAX }}
      </span>
    </header>
    <p v-if="milestone.note" class="pre small">{{ milestone.note }}</p>

    <ul v-if="milestone.snapshots.length" class="log-links" :aria-label="`${label} 스냅샷`">
      <li v-for="snap in milestone.snapshots" :key="snap.artifactVersionId" class="snapshot-row">
        <span>
          📎
          <a v-if="snap.contentUrl" :href="snap.contentUrl" target="_blank" rel="noopener">{{ snap.title }} v{{ snap.versionNo }}</a>
          <span v-else>{{ snap.title }} v{{ snap.versionNo }}</span>
          <span v-if="snap.note" class="muted"> — {{ snap.note }}</span>
          <span v-if="snap.retrospective && !milestone.retrospective" class="badge retro small">사후 작성</span>
        </span>
        <button
          v-if="canWrite"
          type="button"
          class="link-button"
          :aria-label="`${snap.title} v${snap.versionNo} 스냅샷 빼기`"
          @click="removeSnapshot(snap.artifactVersionId, `${snap.title} v${snap.versionNo}`)"
        >
          빼기
        </button>
      </li>
    </ul>

    <div v-if="canWrite" class="actions milestone-controls">
      <button
        :id="`${base}-up`"
        type="button"
        class="secondary icon-button"
        :disabled="index === 0 || busy"
        :aria-label="`${label} 위로 이동`"
        @click="emit('move', -1)"
      >
        ▲
      </button>
      <button
        :id="`${base}-down`"
        type="button"
        class="secondary icon-button"
        :disabled="index === total - 1 || busy"
        :aria-label="`${label} 아래로 이동`"
        @click="emit('move', 1)"
      >
        ▼
      </button>
      <button v-if="!editing" type="button" class="secondary" @click="startEdit">수정</button>
      <button type="button" class="danger" @click="emit('remove')">삭제</button>
    </div>

    <p v-if="status" :class="['notice', status.kind]" :role="status.kind === 'error' ? 'alert' : 'status'">{{ status.text }}</p>

    <form v-if="editing" class="stack edit-form" novalidate :aria-label="`${label} 수정`" @submit.prevent="saveEdit">
      <div class="field">
        <label :for="`${base}-title`">이름 (필수, 80자 이내)</label>
        <input :id="`${base}-title`" v-model="form.title" maxlength="80" :aria-invalid="errors.title ? 'true' : undefined" :aria-describedby="errors.title ? `${base}-title-error` : undefined" />
        <p v-if="errors.title" :id="`${base}-title-error`" class="field-error">{{ fieldMessage(errors.title) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-due`">예정일 (선택)</label>
        <input :id="`${base}-due`" v-model="form.dueAt" type="date" :aria-invalid="errors.dueAt ? 'true' : undefined" :aria-describedby="errors.dueAt ? `${base}-due-error` : undefined" />
        <p v-if="errors.dueAt" :id="`${base}-due-error`" class="field-error">{{ fieldMessage(errors.dueAt) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-claimed`">{{ retro || milestone.retrospective ? '기억·파일 기준 날짜(자기 기입)' : '도달일 (선택, 자기 기입)' }}</label>
        <input :id="`${base}-claimed`" v-model="form.claimedAt" type="date" :aria-invalid="errors.claimedAt ? 'true' : undefined" :aria-describedby="`${base}-claimed-hint${errors.claimedAt ? ` ${base}-claimed-error` : ''}`" />
        <p :id="`${base}-claimed-hint`" class="hint">실제로 이 단계에 도달했다고 스스로 적는 날짜입니다. 플랫폼이 확인한 값이 아닙니다.</p>
        <p v-if="errors.claimedAt" :id="`${base}-claimed-error`" class="field-error">{{ fieldMessage(errors.claimedAt) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-note`">메모 (선택, 500자 이내)</label>
        <textarea :id="`${base}-note`" v-model="form.note" maxlength="500" :aria-invalid="errors.note ? 'true' : undefined" />
        <p v-if="errors.note" class="field-error">{{ fieldMessage(errors.note) }}</p>
      </div>
      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : '저장' }}</button>
        <button type="button" class="secondary" @click="editing = false">취소</button>
      </div>
    </form>

    <form v-if="canWrite && !full" class="stack snapshot-picker" novalidate :aria-label="`${label} 스냅샷 지정`" @submit.prevent="addSnapshot">
      <div class="field">
        <label :for="`${base}-snap`">스냅샷으로 지정할 파일</label>
        <select :id="`${base}-snap`" v-model="pick.versionId" :aria-describedby="`${base}-snap-hint${pickError ? ` ${base}-snap-error` : ''}`" :aria-invalid="pickError ? 'true' : undefined">
          <option value="">{{ snapshotChoices.length ? '파일을 고르세요' : '올린 파일이 없습니다' }}</option>
          <option v-for="option in snapshotChoices" :key="option.versionId" :value="option.versionId" :disabled="!!option.disabledReason">
            {{ option.label }}{{ option.disabledReason ? ` (${option.disabledReason})` : '' }}
          </option>
        </select>
        <p :id="`${base}-snap-hint`" class="hint">검사를 통과한(사용 가능) 파일만 지정할 수 있습니다. 검사 중인 파일은 끝나면 고를 수 있습니다.</p>
        <p v-if="pickError" :id="`${base}-snap-error`" class="field-error" role="alert">{{ pickError }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-snap-note`">한 줄 설명 (선택)</label>
        <input :id="`${base}-snap-note`" v-model="pick.note" maxlength="300" placeholder="예: 중간발표 슬라이드 첫 장" />
      </div>
      <div class="actions">
        <button type="submit" class="secondary" :disabled="adding || !selectable">스냅샷 지정</button>
      </div>
    </form>
    <p v-else-if="canWrite" class="hint">스냅샷은 마일스톤마다 {{ SNAPSHOT_MAX }}개까지입니다.</p>
  </article>
</template>
