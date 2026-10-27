<script setup lang="ts">
/**
 * 운영자 커뮤니티 제재 도구(C-06, ADR 0023). 운영자가 아니면 404로 보입니다(API는 403 operator_only). noindex.
 * - 방 운영진의 제재 요청: 대상 글·댓글(작성자 없음) → 사유를 기록한 작성자 확인 → 이용 제한 발급, 또는 기각.
 * - 이용 제한 목록(대상자 없음 — 목록이 작성자 확인의 우회가 되지 않게)과 해제.
 * - 작성자 확인 기록(누가·언제·어떤 글·사유, 확인한 작성자는 싣지 않음).
 * - 방 운영진 가리기 목록과 되돌리기.
 * 절차는 docs/ops/RUNBOOK.md §4.3.
 */
import type { OperatorAuthorLookupDto, OperatorSanctionDto, OperatorSanctionRequestDto, OperatorSpaceHideDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '커뮤니티 제재 — Peerchive', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const fetcher = useRequestFetch()
const { data: requests, error, refresh: refreshRequests } = await useAsyncData('op-sanction-requests', () =>
  fetcher<OperatorSanctionRequestDto[]>('/api/v1/operator/community/sanction-requests'),
)
const sanctionStatus = ref<'active' | 'all'>('active')
const { data: sanctions, refresh: refreshSanctions } = await useAsyncData(
  'op-sanctions',
  () => fetcher<OperatorSanctionDto[]>('/api/v1/operator/community/sanctions', { query: { status: sanctionStatus.value } }).catch(() => []),
  { watch: [sanctionStatus] },
)
const { data: lookups, refresh: refreshLookups } = await useAsyncData('op-lookups', () =>
  fetcher<OperatorAuthorLookupDto[]>('/api/v1/operator/community/author-lookups').catch(() => []),
)
const { data: hides, refresh: refreshHides } = await useAsyncData('op-space-hides', () =>
  fetcher<OperatorSpaceHideDto[]>('/api/v1/operator/community/space-hides').catch(() => []),
)
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const notes = reactive<Record<string, string>>({})
const busy = ref(false)

async function post(url: string, note: string | undefined, ok: string) {
  notice.value = null
  busy.value = true
  try {
    await $fetch(url, { method: 'POST', body: { note: note ?? '' } })
    notice.value = { kind: 'ok', text: ok }
    await Promise.all([refreshRequests(), refreshSanctions(), refreshLookups(), refreshHides()])
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '메모를 적어 주세요.' : moderationErrorMessage(err.code) }
  } finally {
    busy.value = false
  }
}
async function onIssued() {
  // 발급하면 요청이 닫혀 목록에서 빠지므로(그 안의 안내도 사라짐) 화면 위쪽에 알립니다.
  notice.value = { kind: 'ok', text: '이용 제한을 발급했습니다. 당사자에게 사유와 이의제기 안내가 보입니다.' }
  await Promise.all([refreshRequests(), refreshSanctions(), refreshLookups()])
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink> · <NuxtLink to="/operator/community">커뮤니티 운영</NuxtLink></p>
      <h1>커뮤니티 제재</h1>
      <p class="hint">
        익명 작성자 확인은 사유를 기록할 때만 하고, 확인 결과는 그 화면에만 보입니다. 이용 제한은 커뮤니티 쓰기만 막고 과제 공간·포트폴리오·공개 프로필·과목 허브에는
        영향이 없습니다. 모든 확인·발급·해제는 감사 기록에 남습니다(사유는 조회 기록·조치 메모에).
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <section aria-labelledby="op-sr">
        <h2 id="op-sr">방 운영진의 제재 요청</h2>
        <ul v-if="requests?.length" class="plain operator-list" data-testid="op-sanction-requests">
          <li v-for="r in requests" :key="r.id">
            <p>
              <strong>{{ r.item?.space.name ?? '공간' }}</strong> · {{ r.targetType === 'post' ? '글' : '댓글' }} · {{ REPORT_REASON_LABELS[r.reason] }}
              <span class="small muted"> · 요청 {{ r.requestedBy }} · {{ formatDateTime(r.createdAt) }}</span>
            </p>
            <p v-if="r.details" class="small pre">요청 설명: {{ r.details }}</p>
            <template v-if="r.item">
              <p v-if="r.item.title"><strong>{{ r.item.title }}</strong></p>
              <p v-if="r.item.body" class="pre small">{{ r.item.body }}</p>
              <p class="small muted">{{ r.item.authorLabel }} · {{ COMMUNITY_ITEM_STATUS_LABELS[r.item.status] }} · {{ formatDateTime(r.item.createdAt) }}</p>
            </template>
            <details class="stack">
              <summary>작성자 확인·이용 제한</summary>
              <OperatorAuthorLookup :target-type="r.targetType" :target-id="r.targetId" :request-id="r.id" :id-prefix="`sr-${r.id}`" @issued="onIssued" />
            </details>
            <form class="stack" @submit.prevent="post(`/api/v1/operator/community/sanction-requests/${r.id}/dismiss`, notes[r.id], '요청을 기각했습니다.')">
              <div class="field">
                <label :for="`srd-${r.id}`">기각 메모(필수)</label>
                <textarea :id="`srd-${r.id}`" v-model="notes[r.id]" rows="2" maxlength="1000" required />
              </div>
              <p class="actions"><button type="submit" class="secondary" :disabled="busy">제재 없이 닫기</button></p>
            </form>
          </li>
        </ul>
        <p v-else class="muted">열린 요청이 없습니다.</p>
      </section>

      <section aria-labelledby="op-sanctions">
        <h2 id="op-sanctions">이용 제한</h2>
        <div class="field">
          <label for="op-sanction-status">보기</label>
          <select id="op-sanction-status" v-model="sanctionStatus">
            <option value="active">적용 중</option>
            <option value="all">전체(최근 100)</option>
          </select>
        </div>
        <p class="hint">대상자는 이 목록에 보이지 않습니다. 필요하면 대상 글에서 사유를 기록하고 작성자를 다시 확인하세요.</p>
        <ul v-if="sanctions?.length" class="plain operator-list" data-testid="op-sanctions">
          <li v-for="s in sanctions" :key="s.id">
            <p>
              <strong>{{ SANCTION_LEVEL_TEXT[s.level] }}</strong> · {{ s.scope === 'community' ? '커뮤니티 전체' : `공간: ${s.space?.name ?? '?'}` }}
              <template v-if="s.until"> · {{ formatDateTime(s.until) }}까지</template>
              <span class="badge">{{ s.active ? '적용 중' : s.revokedAt ? '해제됨' : '끝남' }}</span>
              <span v-if="s.appeal" class="badge">이의제기 {{ APPEAL_STATUS_LABELS[s.appeal.status] }}</span>
            </p>
            <p class="small">당사자 사유: {{ s.publicReason }} · 내부 메모: {{ s.internalNote }}</p>
            <p class="small muted">발급 {{ s.issuedBy }} · {{ formatDateTime(s.createdAt) }} · 대상 {{ s.targetType === 'post' ? '글' : '댓글' }} {{ s.targetId }}</p>
            <form v-if="!s.revokedAt" class="stack" @submit.prevent="post(`/api/v1/operator/community/sanctions/${s.id}/revoke`, notes[s.id], '제재를 해제했습니다.')">
              <div class="field">
                <label :for="`sv-${s.id}`">해제 메모(필수)</label>
                <textarea :id="`sv-${s.id}`" v-model="notes[s.id]" rows="2" maxlength="1000" required />
              </div>
              <p class="actions"><button type="submit" class="secondary" :disabled="busy">해제</button></p>
            </form>
          </li>
        </ul>
        <p v-else class="muted">없습니다.</p>
      </section>

      <section aria-labelledby="op-lookups">
        <h2 id="op-lookups">작성자 확인 기록</h2>
        <p class="hint">누가 언제 어떤 글의 작성자를 왜 확인했는지만 보입니다(확인한 작성자는 싣지 않음).</p>
        <table v-if="lookups?.length" class="operator-table" data-testid="op-lookup-log">
          <caption class="visually-hidden">작성자 확인 기록</caption>
          <thead>
            <tr><th scope="col">시각</th><th scope="col">운영자</th><th scope="col">대상</th><th scope="col">사유</th><th scope="col">근거</th><th scope="col">제재</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in lookups" :key="l.id">
              <td>{{ formatDateTime(l.createdAt) }}</td>
              <td>{{ l.operator }}</td>
              <td class="small mono">{{ l.targetType === 'post' ? '글' : '댓글' }} {{ l.targetId }}</td>
              <td class="small pre">{{ l.reason }}</td>
              <td class="small">{{ l.reportId ? '신고' : l.requestId ? '제재 요청' : '없음' }}</td>
              <td>{{ l.sanctioned ? '발급' : '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">없습니다.</p>
      </section>

      <section aria-labelledby="op-hides">
        <h2 id="op-hides">방 운영진 가리기</h2>
        <ul v-if="hides?.length" class="plain operator-list">
          <li v-for="h in hides" :key="h.actionId">
            <p>
              <strong>{{ h.space?.name ?? '공간' }}</strong> · {{ h.targetType === 'post' ? '글' : '댓글' }} · {{ h.publicReason }}
              <span v-if="h.reversedAt" class="badge">되돌림</span>
            </p>
            <p class="small muted">{{ h.createdBy }} · {{ formatDateTime(h.createdAt) }} · 메모: {{ h.internalNote }}</p>
            <form v-if="!h.reversedAt" class="stack" @submit.prevent="post(`/api/v1/operator/community/space-hides/${h.actionId}/reverse`, notes[h.actionId], '가리기를 되돌렸습니다.')">
              <div class="field">
                <label :for="`hr-${h.actionId}`">되돌림 메모(필수)</label>
                <textarea :id="`hr-${h.actionId}`" v-model="notes[h.actionId]" rows="2" maxlength="1000" required />
              </div>
              <p class="actions"><button type="submit" class="secondary" :disabled="busy">되돌리기</button></p>
            </form>
          </li>
        </ul>
        <p v-else class="muted">없습니다.</p>
      </section>
    </template>
  </div>
</template>
