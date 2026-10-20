<script setup lang="ts">
/**
 * 과제 공간의 마일스톤(T-06): 순서 목록(▲▼로 순서 변경)·추가·기본 단계 불러오기·삭제, 각 마일스톤의 스냅샷, 진화 보기.
 *
 * - 관리 버튼과 폼은 owner/editor에게만 보입니다. reviewer/viewer는 목록과 진화 보기만 봅니다.
 * - 마일스톤은 순서 안내이며 완료 게이트가 아닙니다(체크 표시·진행률 없음).
 * - 순서 변경은 전체 순서를 보내고(서버는 전체 순열만 받음), 실패하면 최신 목록을 다시 불러옵니다.
 *   옮긴 뒤에도 키보드 포커스가 같은 마일스톤의 이동 버튼에 남도록 되돌립니다.
 */
import type { MilestoneDto } from '~~/shared/types/api'

const props = defineProps<{
  projectId: string
  canWrite: boolean
  /** 사후 작성 모드(T-07): 도달일을 "기억·파일 기준 날짜(자기 기입)"로 부르고 눈에 띄게 표시합니다. */
  retro?: boolean
}>()
const { items, loaded, loadError, refresh, replace } = useProjectMilestones(props.projectId)
const artifacts = useProjectArtifacts(props.projectId)

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const say = (kind: 'ok' | 'error', text: string) => (notice.value = { kind, text })
const full = computed(() => items.value.length >= MILESTONE_MAX)

const choicesFor = (milestone: MilestoneDto) => snapshotOptions(artifacts.items.value, milestone)

// ── 추가 ──
const form = reactive({ title: '', dueAt: '', claimedAt: '', note: '' })
const errors = ref<Record<string, string>>({})
const creating = ref(false)

async function create() {
  creating.value = true
  errors.value = {}
  try {
    const created = await $fetch<MilestoneDto>(`/api/v1/projects/${props.projectId}/milestones`, {
      method: 'POST',
      body: { title: form.title, dueAt: form.dueAt || null, claimedAt: form.claimedAt || null, note: form.note || null },
    })
    replace(created)
    Object.assign(form, { title: '', dueAt: '', claimedAt: '', note: '' })
    say('ok', `${milestoneLabel(created)}을(를) 추가했습니다.`)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) errors.value = error.fields
    else if (error.code === 'limit_reached') say('error', `마일스톤은 과제마다 ${MILESTONE_MAX}개까지입니다.`)
    else say('error', '추가하지 못했습니다. 다시 시도하세요.')
    if (error.status === 409) await refresh()
  } finally {
    creating.value = false
  }
}

async function applyTemplate() {
  try {
    items.value = await $fetch<MilestoneDto[]>(`/api/v1/projects/${props.projectId}/milestones/apply-template`, { method: 'POST' })
    say('ok', '기본 단계를 불러왔습니다. 이름과 순서는 자유롭게 바꿀 수 있습니다.')
  } catch (e) {
    say('error', milestoneErrorMessage(apiError(e).code, '기본 단계를 불러오지 못했습니다.'))
    await refresh()
  }
}

// ── 순서 변경 ──
const reordering = ref(false)

async function move(milestone: MilestoneDto, index: number, delta: -1 | 1) {
  const ids = moveId(
    items.value.map((m) => m.id),
    index,
    delta,
  )
  if (!ids || reordering.value) return
  reordering.value = true
  try {
    items.value = await $fetch<MilestoneDto[]>(`/api/v1/projects/${props.projectId}/milestones/order`, {
      method: 'PUT',
      body: { milestoneIds: ids },
    })
    const moved = items.value.find((m) => m.id === milestone.id)
    say('ok', `${milestone.title}을(를) ${moved?.position ?? index + 1 + delta}번째로 옮겼습니다.`)
  } catch (e) {
    const error = apiError(e)
    say('error', error.status === 422 ? fieldMessage('mismatch')! : '순서를 바꾸지 못했습니다. 다시 시도하세요.')
    await refresh()
  } finally {
    reordering.value = false
  }
  // 옮긴 마일스톤의 같은 방향 버튼(끝에 닿았으면 반대 방향)에 포커스를 둡니다.
  await nextTick()
  const at = items.value.findIndex((m) => m.id === milestone.id)
  const edge = delta === -1 ? at === 0 : at === items.value.length - 1
  const direction = (delta === -1) !== edge ? 'up' : 'down'
  document.getElementById(`ms-${milestone.id}-${direction}`)?.focus()
}

// ── 삭제 ──
async function remove(milestone: MilestoneDto) {
  if (!confirm(`${milestoneLabel(milestone)}을(를) 삭제할까요? 지정한 스냅샷도 함께 빠집니다(파일은 남음).`)) return
  try {
    await $fetch(`/api/v1/milestones/${milestone.id}`, { method: 'DELETE' })
    say('ok', `${milestone.title}을(를) 삭제했습니다.`)
  } catch (e) {
    say('error', milestoneErrorMessage(apiError(e).code, '삭제하지 못했습니다. 다시 시도하세요.'))
  }
  await refresh()
}

onMounted(() => {
  void refresh()
  if (!artifacts.loaded.value) void artifacts.refresh()
})
</script>

<template>
  <section class="card" aria-labelledby="milestones-heading">
    <h2 id="milestones-heading">마일스톤</h2>
    <p class="hint">
      과제를 몇 개 구간으로 나누고, 각 구간의 산출물을 스냅샷으로 남깁니다. 순서 안내일 뿐 완료 게이트가 아니며, 언제든 이름과 순서를 바꿀 수 있습니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p v-if="loadError" class="notice error" role="alert">
      마일스톤을 불러오지 못했습니다. <button type="button" class="link-button" @click="refresh">다시 시도</button>
    </p>

    <template v-if="loaded && items.length === 0 && !loadError">
      <p class="muted">아직 마일스톤이 없습니다.</p>
      <div v-if="canWrite" class="stack template-offer">
        <p class="hint" id="milestone-template-hint">기본 단계: {{ MILESTONE_TEMPLATE_LABEL }}. 불러온 뒤 이름과 순서를 바꿀 수 있습니다.</p>
        <div class="actions">
          <button type="button" class="secondary" aria-describedby="milestone-template-hint" @click="applyTemplate">기본 단계 불러오기</button>
        </div>
      </div>
    </template>

    <ol v-if="items.length" class="plain milestone-list" aria-label="마일스톤 (순서대로)">
      <li v-for="(milestone, index) in items" :key="milestone.id">
        <MilestoneItem
          :milestone="milestone"
          :index="index"
          :total="items.length"
          :can-write="canWrite"
          :snapshot-choices="choicesFor(milestone)"
          :busy="reordering"
          :retro="retro"
          @move="move(milestone, index, $event)"
          @remove="remove(milestone)"
          @updated="replace"
          @reload="refresh"
        />
      </li>
    </ol>

    <details v-if="canWrite && !full" class="milestone-new">
      <summary>새 마일스톤 추가</summary>
      <form class="stack" novalidate aria-label="새 마일스톤 추가" @submit.prevent="create">
        <div class="field">
          <label for="new-ms-title">이름 (필수, 80자 이내)</label>
          <input id="new-ms-title" v-model="form.title" maxlength="80" placeholder="예: 중간발표" :aria-invalid="errors.title ? 'true' : undefined" :aria-describedby="errors.title ? 'new-ms-title-error' : undefined" />
          <p v-if="errors.title" id="new-ms-title-error" class="field-error">{{ fieldMessage(errors.title) }}</p>
        </div>
        <div class="field">
          <label for="new-ms-due">예정일 (선택)</label>
          <input id="new-ms-due" v-model="form.dueAt" type="date" :aria-invalid="errors.dueAt ? 'true' : undefined" :aria-describedby="errors.dueAt ? 'new-ms-due-error' : undefined" />
          <p v-if="errors.dueAt" id="new-ms-due-error" class="field-error">{{ fieldMessage(errors.dueAt) }}</p>
        </div>
        <div :class="['field', { 'retro-date': retro }]">
          <label for="new-ms-claimed">{{ retro ? '기억·파일 기준 날짜(자기 기입)' : '도달일 (선택, 자기 기입)' }}</label>
          <input id="new-ms-claimed" v-model="form.claimedAt" type="date" :aria-invalid="errors.claimedAt ? 'true' : undefined" :aria-describedby="`new-ms-claimed-hint${errors.claimedAt ? ' new-ms-claimed-error' : ''}`" />
          <p id="new-ms-claimed-hint" class="hint">
            {{ retro ? '파일 수정일·커밋 이력·발표 자료 버전을 보고 이 단계에 도달한 날을 적으세요. 스스로 적는 날짜입니다.' : '이미 지난 단계를 사후에 정리할 때 씁니다. 스스로 적는 날짜입니다.' }}
          </p>
          <p v-if="errors.claimedAt" id="new-ms-claimed-error" class="field-error">{{ fieldMessage(errors.claimedAt) }}</p>
        </div>
        <div class="field">
          <label for="new-ms-note">메모 (선택, 500자 이내)</label>
          <textarea id="new-ms-note" v-model="form.note" maxlength="500" :aria-invalid="errors.note ? 'true' : undefined" />
          <p v-if="errors.note" class="field-error">{{ fieldMessage(errors.note) }}</p>
        </div>
        <div class="actions">
          <button type="submit" :disabled="creating">{{ creating ? '추가 중…' : '추가' }}</button>
        </div>
      </form>
    </details>
    <p v-else-if="canWrite && full" class="hint">마일스톤은 과제마다 {{ MILESTONE_MAX }}개까지입니다.</p>
    <p v-else-if="!canWrite" class="hint">이 과제의 마일스톤을 볼 수 있지만 바꿀 수는 없습니다(편집자 이상만 관리).</p>

    <EvolutionView v-if="items.length" :milestones="items" />
  </section>
</template>
