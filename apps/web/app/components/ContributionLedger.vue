<script setup lang="ts">
/**
 * 기간 기여 요약 표(T-08, pilot-kit §4.1 화면판). 멤버별 기록 종류와 개수, 역할 선언 상태만 보여 줍니다.
 * - 멤버는 이름순(서버 순서 그대로)이며 활동량으로 정렬하지 않습니다. 합계·비율·순위 열이 없습니다.
 * - 기간: 이번 주 / 지난주 / 직접 선택(월~일, Asia/Seoul). 표 아래에 "개수는 참고용" 문장을 항상 보여 줍니다.
 * - 같은 기간으로 동료평가용 인쇄 리포트를 엽니다.
 */
import type { ContributionDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; refreshKey: number }>()

type Mode = 'this' | 'last' | 'custom'
const mode = ref<Mode>('this')
const custom = reactive({ from: '', to: '' })
const period = ref(seoulWeek(new Date()))
const data = ref<ContributionDto | null>(null)
const loadError = ref(false)
const fieldErrors = ref<Record<string, string>>({})
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await $fetch<ContributionDto>(`/api/v1/projects/${props.projectId}/contribution`, { query: { ...period.value } })
    loadError.value = false
    fieldErrors.value = {}
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) fieldErrors.value = error.fields
    else loadError.value = true
  } finally {
    loading.value = false
  }
}

function choose(next: Mode) {
  mode.value = next
  if (next === 'custom') {
    custom.from ||= period.value.from
    custom.to ||= period.value.to
    return
  }
  period.value = seoulWeek(new Date(), next === 'last' ? 1 : 0)
  void load()
}

function applyCustom() {
  fieldErrors.value = {}
  if (!custom.from) fieldErrors.value.from = 'required'
  if (!custom.to) fieldErrors.value.to = 'required'
  if (fieldErrors.value.from || fieldErrors.value.to) return
  period.value = { from: custom.from, to: custom.to }
  void load()
}

const reportUrl = computed(() => `/projects/${props.projectId}/report?from=${period.value.from}&to=${period.value.to}`)
const heading = computed(() => (mode.value === 'this' ? '이번 주 요약' : mode.value === 'last' ? '지난주 요약' : '기간 요약'))

onMounted(load)
watch(() => props.refreshKey, load)
</script>

<template>
  <div class="ledger">
    <h3 id="ledger-heading">{{ heading }}</h3>
    <fieldset class="ledger-period">
      <legend>기간 (월~일, 한국 시간)</legend>
      <div class="inline-options">
        <label><input type="radio" name="ledger-period" :checked="mode === 'this'" @change="choose('this')" /> 이번 주</label>
        <label><input type="radio" name="ledger-period" :checked="mode === 'last'" @change="choose('last')" /> 지난주</label>
        <label><input type="radio" name="ledger-period" :checked="mode === 'custom'" @change="choose('custom')" /> 직접 선택</label>
      </div>
      <form v-if="mode === 'custom'" class="actions ledger-custom" novalidate @submit.prevent="applyCustom">
        <div class="field">
          <label for="ledger-from">시작일</label>
          <input id="ledger-from" v-model="custom.from" type="date" :aria-invalid="fieldErrors.from ? 'true' : undefined" :aria-describedby="fieldErrors.from ? 'ledger-from-error' : undefined" />
          <p v-if="fieldErrors.from" id="ledger-from-error" class="field-error">{{ periodFieldMessage(fieldErrors.from) }}</p>
        </div>
        <div class="field">
          <label for="ledger-to">끝 날짜(포함)</label>
          <input id="ledger-to" v-model="custom.to" type="date" :aria-invalid="fieldErrors.to ? 'true' : undefined" :aria-describedby="fieldErrors.to ? 'ledger-to-error' : undefined" />
          <p v-if="fieldErrors.to" id="ledger-to-error" class="field-error">{{ periodFieldMessage(fieldErrors.to) }}</p>
        </div>
        <button type="submit">적용</button>
      </form>
    </fieldset>

    <p v-if="loadError" class="notice error" role="alert">
      요약을 불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>

    <template v-if="data">
      <p class="muted" aria-live="polite">
        {{ formatPeriod(data.period.from, data.period.to) }}<template v-if="data.period.weekNo"> · {{ data.period.weekNo }}주차</template>
        <template v-if="loading"> · 불러오는 중…</template>
      </p>
      <p v-if="data.milestone" class="small">
        다가오는 마일스톤: {{ data.milestone.title }} ({{ data.milestone.dueAt ? `예정 ${data.milestone.dueAt}` : '예정일 없음' }})<template v-if="data.milestone.snapshotsInPeriod"> — 이 기간 스냅샷 {{ data.milestone.snapshotsInPeriod }}개 등록</template>
      </p>
      <div class="table-scroll" role="region" aria-labelledby="ledger-heading" tabindex="0">
        <table class="ledger-table">
          <caption class="visually-hidden">멤버별 기록 종류와 개수(이름순)</caption>
          <thead>
            <tr>
              <th scope="col">멤버</th>
              <th scope="col">빌드 로그(종류별)</th>
              <th scope="col">할 일 완료</th>
              <th scope="col">파일</th>
              <th scope="col">회의 참석</th>
              <th scope="col">역할 선언</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data.members" :key="row.member.userId">
              <th scope="row">
                {{ row.member.displayName || '이름 미설정' }}<span v-if="!row.active" class="muted small"> (나간 멤버)</span>
              </th>
              <td>
                <template v-if="activityParts(row).length">{{ activityParts(row).join(' · ') }}</template>
                <span v-else class="muted">기록 없음</span>
              </td>
              <td>{{ row.tasksCompleted }}</td>
              <td>{{ row.artifactsUploaded }}</td>
              <td>{{ row.meetingsAttended }}</td>
              <td>
                <span v-if="row.claims.length === 0" class="muted">선언 없음</span>
                <ul v-else class="plain small">
                  <li v-for="claim in row.claims" :key="claim.id">“{{ claim.text }}” — {{ claimStatusLabel(claim) }}</li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="ledger-disclaimer">{{ data.disclaimer }}</p>

      <template v-if="data.unresolvedStuck.length">
        <h4>아직 해결 로그가 없는 막힘</h4>
        <ul class="plain small">
          <li v-for="s in data.unresolvedStuck" :key="s.id">🧱 “{{ s.summary }}” — {{ s.author.displayName || '이름 미설정' }}, {{ s.openDays }}일째</li>
        </ul>
      </template>

      <p>
        <NuxtLink :to="reportUrl">동료평가용 리포트 열기</NuxtLink>
        <span class="muted small"> — 이 기간으로 인쇄하거나 “PDF로 저장”할 수 있습니다.</span>
      </p>
    </template>
  </div>
</template>
