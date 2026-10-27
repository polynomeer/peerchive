<script setup lang="ts">
/**
 * 주간 운영 시간 기록(C-10, ADR 0027). 운영자가 아니면 404로 보입니다(API는 403 operator_only).
 * 내 기록만 보이고(다른 운영자의 기록·순위 없음), 지표에는 주·분야별 합계만 나갑니다. 메모(200자)는 본인만 봅니다.
 */
import type { MyOpsTimeDto, OpsTimeCategory, OpsTimeEntryDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '주간 운영 시간 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const CATEGORIES: Array<{ key: OpsTimeCategory; label: string }> = [
  { key: 'reports', label: '신고 검토' },
  { key: 'official_pages', label: '공식 페이지 운영' },
  { key: 'affiliation_support', label: '학교 인증 지원' },
  { key: 'curation', label: '큐레이션' },
  { key: 'other', label: '기타' },
]

const { data, error, refresh } = await useFetch<MyOpsTimeDto>('/api/v1/operator/ops-time')
const denied = computed(() => !!error.value && [401, 403].includes(error.value.statusCode ?? 0))
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const blank = (): Record<OpsTimeCategory, number> => ({ reports: 0, official_pages: 0, affiliation_support: 0, curation: 0, other: 0 })
const form = reactive({ week: '', minutes: blank(), note: '' })
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const total = computed(() => CATEGORIES.reduce((s, c) => s + (Number(form.minutes[c.key]) || 0), 0))

function load(entry: OpsTimeEntryDto | undefined, week: string) {
  form.week = week
  form.minutes = entry ? { ...entry.minutes } : blank()
  form.note = entry?.note ?? ''
}
watch(
  data,
  (d) => {
    if (d && !form.week) load(d.entries.find((e) => e.week === d.currentWeek), d.currentWeek)
  },
  { immediate: true },
)

const hoursText = (minutes: number) => `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
const ERRORS: Record<string, string> = {
  future: '이번 주 이후는 기록할 수 없습니다.',
  too_old: '52주보다 오래된 주는 기록할 수 없습니다.',
  invalid: '주 형식(예: 2026-W44)을 확인하세요.',
  too_many: '한 주 합계는 7일(10080분)을 넘을 수 없습니다.',
  too_long: '메모는 200자까지입니다.',
}

async function save() {
  message.value = null
  try {
    await $fetch(`/api/v1/operator/ops-time/${encodeURIComponent(form.week)}`, {
      method: 'PUT',
      body: { minutes: Object.fromEntries(CATEGORIES.map((c) => [c.key, Number(form.minutes[c.key]) || 0])), note: form.note || null },
    })
    message.value = { kind: 'ok', text: `${form.week} 기록을 저장했습니다.` }
    await refresh()
  } catch (e) {
    const err = apiError(e)
    const field = Object.values(err.fields ?? {})[0]
    message.value = { kind: 'error', text: (field && ERRORS[field]) || '저장하지 못했습니다.' }
  }
}

async function remove(week: string) {
  message.value = null
  try {
    await $fetch(`/api/v1/operator/ops-time/${encodeURIComponent(week)}`, { method: 'DELETE' })
    message.value = { kind: 'ok', text: `${week} 기록을 지웠습니다.` }
    await refresh()
    if (form.week === week) load(undefined, week)
  } catch {
    message.value = { kind: 'error', text: '지우지 못했습니다.' }
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else-if="data">
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink> · <NuxtLink to="/operator/community-metrics">커뮤니티 지표</NuxtLink></p>
      <h1>주간 운영 시간</h1>
      <p class="hint">
        한 주(월~일, 서울 시각)에 운영에 쓴 시간을 분야별로 적습니다. 다른 운영자는 내 기록을 볼 수 없고, 지표에는 주·분야별 합계만 나갑니다(5 미만은 가림).
      </p>
      <form class="stack" @submit.prevent="save">
        <div class="field">
          <label for="ops-week">주</label>
          <input id="ops-week" v-model="form.week" type="text" pattern="\d{4}-W\d{2}" placeholder="2026-W44" required aria-describedby="ops-week-hint" />
          <p id="ops-week-hint" class="hint">이번 주는 {{ data.currentWeek }}입니다. 52주 안의 지난 주도 고칠 수 있습니다.</p>
        </div>
        <fieldset>
          <legend>분야별 시간(분)</legend>
          <div class="ops-time-grid">
            <div v-for="c in CATEGORIES" :key="c.key" class="field">
              <label :for="`ops-${c.key}`">{{ c.label }}</label>
              <input :id="`ops-${c.key}`" v-model.number="form.minutes[c.key]" type="number" min="0" max="10080" step="5" inputmode="numeric" />
            </div>
          </div>
        </fieldset>
        <p class="small" aria-live="polite" data-testid="ops-total">합계 {{ hoursText(total) }}</p>
        <div class="field">
          <label for="ops-note">메모(선택, 200자, 나만 봄)</label>
          <textarea id="ops-note" v-model="form.note" rows="2" maxlength="200" />
        </div>
        <p class="actions"><button type="submit">저장</button></p>
      </form>
      <p v-if="message" :class="['notice', message.kind]" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>

      <h2>내 기록(최근 12주)</h2>
      <div v-if="data.entries.length" class="table-scroll" role="region" aria-labelledby="ops-history" tabindex="0">
        <table class="ledger-table" aria-describedby="ops-history">
          <caption id="ops-history" class="small muted">본인 기록만 보입니다.</caption>
          <thead>
            <tr>
              <th scope="col">주</th>
              <th v-for="c in CATEGORIES" :key="c.key" scope="col">{{ c.label }}</th>
              <th scope="col">합계</th>
              <th scope="col"><span class="visually-hidden">동작</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in data.entries" :key="e.week" :data-week="e.week">
              <th scope="row">{{ e.week }}<br /><span class="small muted">{{ e.from }}~{{ e.to }}</span></th>
              <td v-for="c in CATEGORIES" :key="c.key">{{ e.minutes[c.key] }}</td>
              <td>{{ hoursText(e.total) }}</td>
              <td class="actions">
                <button type="button" class="small" @click="load(e, e.week)">고치기</button>
                <button type="button" class="small" @click="remove(e.week)">지우기</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">아직 기록이 없습니다.</p>
    </template>
  </div>
</template>
