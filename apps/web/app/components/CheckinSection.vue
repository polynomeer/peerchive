<script setup lang="ts">
/**
 * 주간 체크인(T-09, PROOFU_EVOLUTION_PLAN §6.4, pilot-kit §3): 60초 폼과 팀 현황.
 * - 투입 시간·체감 난이도·한 줄(선택)·기록을 못 한 이유(선택)·통계 공유(따로 동의, 기본 꺼짐).
 * - 같은 주에 다시 내면 고쳐집니다. 이번 주와 지난주만 낼 수 있습니다.
 * - "이 한 줄을 빌드 로그로 옮기기"는 편집 권한이 있을 때만, 체크인마다 한 번(🔨 진행 또는 🧱 막힘).
 * - 팀 현황은 이 과제 멤버에게만 보이며, 통계 공유 여부와 이유는 본인만 봅니다.
 */
import type {
  CheckinDto,
  CheckinSaveDto,
  CheckinSkipReason,
  CheckinTimeBucket,
  CheckinWeekDto,
  MyCheckinDto,
} from '~~/shared/types/api'

const props = defineProps<{ projectId: string; canWrite: boolean; meId: string | null }>()

const weeks = checkinWeeks()
const week = ref(weeks.current)
const mine = ref<CheckinDto | null>(null)
const team = ref<CheckinWeekDto | null>(null)
const range = ref<{ from: string; to: string } | null>(null)
const loadError = ref(false)
const saving = ref(false)
const errors = ref<Record<string, string>>({})
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const logsChanged = useLogsChanged(props.projectId)

const form = reactive({
  timeBucket: '' as CheckinTimeBucket | '',
  difficulty: 0,
  note: '',
  skipReasons: [] as CheckinSkipReason[],
  shareForStats: false,
  promote: false,
  promoteTag: 'progress' as 'progress' | 'stuck',
})

function fill(checkin: CheckinDto | null) {
  form.timeBucket = checkin?.timeBucket ?? ''
  form.difficulty = checkin?.difficulty ?? 0
  form.note = checkin?.note ?? ''
  form.skipReasons = [...(checkin?.skipReasons ?? [])]
  form.shareForStats = checkin?.shareForStats ?? false
  form.promote = false
}

async function load() {
  try {
    const [me, list] = await Promise.all([
      $fetch<MyCheckinDto>(`/api/v1/projects/${props.projectId}/checkins/me`, { query: { week: week.value } }),
      $fetch<CheckinWeekDto>(`/api/v1/projects/${props.projectId}/checkins`, { query: { week: week.value } }),
    ])
    mine.value = me.checkin
    range.value = { from: me.from, to: me.to }
    team.value = list
    fill(me.checkin)
    loadError.value = false
  } catch {
    loadError.value = true
  }
}

watch(week, () => {
  status.value = null
  errors.value = {}
  void load()
})
onMounted(load)

const canPromote = computed(() => props.canWrite && !mine.value?.promotedLogId)
const ready = computed(() => form.timeBucket !== '' && form.difficulty >= 1)

async function submit() {
  if (!ready.value) {
    errors.value = {
      ...(form.timeBucket ? {} : { timeBucket: 'required' }),
      ...(form.difficulty ? {} : { difficulty: 'required' }),
    }
    return
  }
  saving.value = true
  errors.value = {}
  status.value = null
  try {
    const res = await $fetch<CheckinSaveDto>(`/api/v1/projects/${props.projectId}/checkins/me`, {
      method: 'PUT',
      body: {
        week: week.value,
        timeBucket: form.timeBucket,
        difficulty: form.difficulty,
        note: form.note,
        skipReasons: form.skipReasons,
        shareForStats: form.shareForStats,
        promote: form.promote && canPromote.value ? { tag: form.promoteTag } : null,
      },
    })
    const promoted = !!res.log && !mine.value?.promotedLogId
    mine.value = res.checkin
    status.value = { kind: 'ok', text: promoted ? '체크인을 저장하고 한 줄을 빌드 로그로 옮겼습니다.' : '체크인을 저장했습니다.' }
    if (promoted) logsChanged.notify()
    form.promote = false
    team.value = await $fetch<CheckinWeekDto>(`/api/v1/projects/${props.projectId}/checkins`, { query: { week: week.value } })
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) {
      errors.value = err.fields
      status.value = {
        kind: 'error',
        text: err.fields.week === 'out_of_range' ? '이번 주와 지난주만 낼 수 있습니다.' : '입력을 확인해 주세요.',
      }
    } else if (err.status === 403) {
      status.value = { kind: 'error', text: '빌드 로그로 옮기려면 편집 권한이 필요합니다. 옮기기를 끄고 다시 저장하세요.' }
    } else {
      status.value = { kind: 'error', text: '저장하지 못했습니다. 입력은 남아 있으니 다시 시도하세요.' }
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section id="checkin" class="card" aria-labelledby="checkin-heading">
    <h2 id="checkin-heading">주간 체크인</h2>
    <p class="hint">60초면 됩니다. 팀 안에서만 보이고, 같은 주에 다시 내면 고쳐집니다.</p>

    <fieldset>
      <legend>주</legend>
      <div class="inline-options">
        <label><input v-model="week" type="radio" name="checkin-week" :value="weeks.current" /> 이번 주</label>
        <label><input v-model="week" type="radio" name="checkin-week" :value="weeks.previous" /> 지난주</label>
        <span v-if="range" class="muted">{{ range.from }} ~ {{ range.to }}</span>
      </div>
    </fieldset>

    <p v-if="loadError" class="notice error" role="alert">
      체크인을 불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>

    <form class="stack" novalidate @submit.prevent="submit">
      <fieldset :aria-invalid="errors.timeBucket ? 'true' : undefined">
        <legend>1. 이번 주 이 과제에 쓴 시간</legend>
        <div class="inline-options">
          <label v-for="o in CHECKIN_TIME_OPTIONS" :key="o.value">
            <input v-model="form.timeBucket" type="radio" name="checkin-time" :value="o.value" /> {{ o.label }}
          </label>
        </div>
        <p v-if="errors.timeBucket" class="field-error">{{ fieldMessage(errors.timeBucket) }}</p>
      </fieldset>

      <fieldset :aria-invalid="errors.difficulty ? 'true' : undefined">
        <legend>2. 체감 난이도</legend>
        <div class="inline-options">
          <label v-for="o in DIFFICULTY_OPTIONS" :key="o.value">
            <input v-model.number="form.difficulty" type="radio" name="checkin-difficulty" :value="o.value" /> {{ o.label }}
          </label>
        </div>
        <p v-if="errors.difficulty" class="field-error">{{ fieldMessage(errors.difficulty) }}</p>
      </fieldset>

      <div class="field">
        <label for="checkin-note">3. 이번 주 가장 중요한 진전 또는 막힘 한 줄 (선택)</label>
        <input
          id="checkin-note"
          v-model="form.note"
          :maxlength="CHECKIN_NOTE_LIMIT"
          aria-describedby="checkin-note-count"
          :aria-invalid="errors.note ? 'true' : undefined"
        />
        <p id="checkin-note-count" class="hint">{{ form.note.length }} / {{ CHECKIN_NOTE_LIMIT }}자</p>
        <p v-if="errors.note" class="field-error">{{ fieldMessage(errors.note) }}</p>
      </div>

      <div v-if="mine?.promotedLogId" class="hint">
        이 체크인의 한 줄은 이미 <a :href="`#log-${mine.promotedLogId}`">빌드 로그</a>로 옮겼습니다. 한 줄을 고쳐도 로그는 바뀌지 않습니다.
      </div>
      <fieldset v-else-if="canPromote && form.note.trim()">
        <legend>4. 이 한 줄을 빌드 로그로 옮길까요?</legend>
        <label class="check"><input v-model="form.promote" type="checkbox" /> 빌드 로그로 옮기기</label>
        <div v-if="form.promote" class="inline-options">
          <label><input v-model="form.promoteTag" type="radio" name="checkin-promote-tag" value="progress" /> 🔨 진행</label>
          <label><input v-model="form.promoteTag" type="radio" name="checkin-promote-tag" value="stuck" /> 🧱 막힘</label>
        </div>
        <p v-if="form.promote && form.promoteTag === 'stuck'" class="hint">
          한 줄이 증상이 되고, 막힌 시간은 이번 주 시간에서 가장 가까운 값으로 넣습니다. 로그에서 고칠 수 있습니다.
        </p>
      </fieldset>

      <details>
        <summary>이번 주 기록을 못 했거나 덜 했다면 (선택)</summary>
        <div class="inline-options">
          <label v-for="o in SKIP_REASON_OPTIONS" :key="o.value">
            <input v-model="form.skipReasons" type="checkbox" :value="o.value" /> {{ o.label }}
          </label>
        </div>
        <p class="hint">이유는 나만 봅니다.</p>
      </details>

      <div class="field">
        <label class="check">
          <input v-model="form.shareForStats" type="checkbox" aria-describedby="checkin-stats-hint" />
          익명 통계에 보태기 (선택)
        </label>
        <p id="checkin-stats-hint" class="hint">
          켜면 시간·난이도만 같은 과목의 익명 집계에 쓰일 수 있습니다(5명 이상 모였을 때만, 한 줄은 쓰지 않음). 기본은 꺼짐이며 언제든 끌 수 있습니다.
        </p>
      </div>

      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : mine ? '체크인 고치기' : '체크인 내기' }}</button>
        <span v-if="mine" class="muted">마지막 저장 {{ new Date(mine.updatedAt).toLocaleString('ko-KR') }}</span>
      </div>
      <p v-if="status" :class="['notice', status.kind]" :role="status.kind === 'error' ? 'alert' : 'status'">{{ status.text }}</p>
    </form>

    <h3 id="checkin-team-heading">팀 체크인</h3>
    <ul v-if="team" class="plain" aria-labelledby="checkin-team-heading">
      <li v-for="entry in team.entries" :key="entry.member.userId" class="row">
        <span>
          {{ entry.member.displayName || entry.member.handle || '이름 미설정' }}<span v-if="entry.member.userId === meId" class="muted"> (나)</span>
        </span>
        <span v-if="entry.submitted">
          {{ CHECKIN_TIME_LABELS[entry.timeBucket!] }} · 난이도 {{ entry.difficulty }}
          <template v-if="entry.note"> · “{{ entry.note }}”</template>
        </span>
        <span v-else class="muted">아직 안 냄</span>
      </li>
    </ul>
  </section>
</template>
