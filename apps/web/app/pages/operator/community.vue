<script setup lang="ts">
/**
 * 운영자 커뮤니티 도구(C-02, ADR 0019). 운영자가 아니면 404로 보입니다(API는 403 operator_only). noindex.
 * - 공식 페이지 개설 요청 묶음(학교·학과별 요청자 수·학생회 표시·기준 도달). 기준에 이르러도 자동으로 열지 않고 운영자가 엽니다.
 * - 공식 페이지 열기(학교 id + 학과 선택), 공간 목록(정보만 — 게시판·멤버 목록은 운영자에게도 보이지 않음)과 제한·해제·보관·정원 결정.
 * - 토픽 열기(A-05, ADR 0042): P2 topics 플래그가 켜져 있을 때만 보입니다(꺼지면 API 404). CLI `pnpm --filter @peerchive/db topic create`도 같은 규칙.
 * 절차는 docs/ops/RUNBOOK.md §4.2.
 */
import type { OperatorOfficialRequestGroupDto, OperatorSpaceDto, SpaceDetailDto, SpaceStatus, TopicCategory } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '커뮤니티 운영 — Peerchive', meta: [{ name: 'robots', content: 'noindex, nofollow' }] })

const fetcher = useRequestFetch()
const { data: groups, error, refresh: refreshGroups } = await useAsyncData('op-official-requests', () =>
  fetcher<OperatorOfficialRequestGroupDto[]>('/api/v1/operator/community/official-requests'),
)
const statusFilter = ref<SpaceStatus | ''>('')
const { data: spaces, refresh: refreshSpaces } = await useAsyncData(
  'op-spaces',
  () => fetcher<OperatorSpaceDto[]>('/api/v1/operator/community/spaces', { query: statusFilter.value ? { status: statusFilter.value } : {} }).catch(() => []),
  { watch: [statusFilter] },
)
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
function fail(e: unknown) {
  const err = apiError(e)
  notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
}

const { flags, ensure: ensureFeatures } = useFeatures()
await ensureFeatures()
const TOPIC_CATEGORY_TEXT: Record<TopicCategory, string> = {
  career: '취준',
  grad_school: '대학원',
  startup: '창업',
  military: '군대·예비역',
  campus_life: '학교생활',
  role: '직무',
}
const topicForm = reactive({ name: '', description: '', category: 'career' as TopicCategory })
async function createTopic() {
  busy.value = 'topic'
  notice.value = null
  try {
    const created = await $fetch<SpaceDetailDto>('/api/v1/operator/community/topics', {
      method: 'POST',
      body: { name: topicForm.name, description: topicForm.description || null, category: topicForm.category },
    })
    notice.value = { kind: 'ok', text: `토픽 “${created.name}”을 열었습니다.` }
    topicForm.name = ''
    topicForm.description = ''
    await refreshSpaces()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

const form = reactive({ schoolId: '', departmentLabel: '', name: '', description: '' })
function prefill(g: OperatorOfficialRequestGroupDto) {
  form.schoolId = g.school.id
  form.departmentLabel = g.departmentLabel ?? ''
  form.name = ''
  document.getElementById('official-school-id')?.focus()
}
async function createOfficial() {
  busy.value = 'create'
  notice.value = null
  try {
    const created = await $fetch<SpaceDetailDto>('/api/v1/operator/community/official-pages', {
      method: 'POST',
      body: { schoolId: form.schoolId.trim(), departmentLabel: form.departmentLabel || null, name: form.name || null, description: form.description || null },
    })
    notice.value = { kind: 'ok', text: `공식 페이지 “${created.name}”을 열었습니다.` }
    form.schoolId = ''
    form.departmentLabel = ''
    form.name = ''
    form.description = ''
    await Promise.all([refreshGroups(), refreshSpaces()])
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function markCouncil(g: OperatorOfficialRequestGroupDto) {
  if (!window.confirm('이 요청을 학생회 요청으로 확인했습니까? 확인하면 개설 검토 기준에 이른 것으로 봅니다.')) return
  busy.value = g.latestRequestId
  try {
    await $fetch(`/api/v1/operator/community/official-requests/${g.latestRequestId}/student-council`, { method: 'POST' })
    await refreshGroups()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

async function spaceAction(s: OperatorSpaceDto, action: 'restrict' | 'lift-restriction' | 'archive') {
  const labels = { restrict: '제한', 'lift-restriction': '제한 해제', archive: '보관' } as const
  const note = window.prompt(`${s.name} ${labels[action]} 사유(감사 기록에 남음)`)
  if (!note) return
  busy.value = s.id
  notice.value = null
  try {
    await $fetch(`/api/v1/operator/community/spaces/${s.id}/${action}`, { method: 'POST', body: { note } })
    notice.value = { kind: 'ok', text: `${s.name}: ${labels[action]} 완료` }
    await refreshSpaces()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function decideCapacity(s: OperatorSpaceDto) {
  const value = window.prompt(`${s.name} 정원(요청 ${s.capacityRequested ?? '-'}명, 2~2000)`, String(s.capacityRequested ?? s.capacity))
  if (!value) return
  busy.value = s.id
  try {
    await $fetch(`/api/v1/operator/community/spaces/${s.id}/capacity`, { method: 'POST', body: { capacity: Number(value) } })
    await refreshSpaces()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <h1>커뮤니티 운영</h1>
      <p><NuxtLink to="/operator">신고 대기열로</NuxtLink></p>
      <p class="hint">운영자도 사용자 방의 게시판·멤버 목록은 볼 수 없습니다(공간 정보만). 모든 처리는 감사 기록에 남습니다.</p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <section aria-labelledby="op-requests">
        <h2 id="op-requests">공식 페이지 개설 요청</h2>
        <ul v-if="groups?.length" class="plain operator-list">
          <li v-for="g in groups" :key="`${g.school.id}:${g.departmentKey}`">
            <p>
              <strong>{{ g.school.name }}{{ g.departmentLabel ? ` ${g.departmentLabel}` : '' }}</strong>
              <span v-if="g.thresholdReached" class="badge">검토 기준 도달</span>
              <span v-if="g.studentCouncil" class="badge">학생회 요청</span>
            </p>
            <p class="small">인증 요청자 {{ g.requesters }}명 · 처음 {{ formatDateTime(g.firstRequestedAt) }} · 마지막 {{ formatDateTime(g.lastRequestedAt) }}</p>
            <p class="actions">
              <NuxtLink v-if="g.existingSpaceSlug" :to="`/community/s/${g.existingSpaceSlug}`">열린 페이지 보기</NuxtLink>
              <button v-else type="button" class="secondary" @click="prefill(g)">이 학교로 개설 양식 채우기</button>
              <button v-if="!g.studentCouncil" type="button" class="link-button" :disabled="busy === g.latestRequestId" @click="markCouncil(g)">학생회 요청으로 표시</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">개설 요청이 없습니다.</p>
      </section>

      <section aria-labelledby="op-create">
        <h2 id="op-create">공식 페이지 열기</h2>
        <form class="stack" novalidate @submit.prevent="createOfficial">
          <div class="field">
            <label for="official-school-id">학교 id</label>
            <input id="official-school-id" v-model="form.schoolId" class="mono" autocomplete="off" aria-describedby="official-school-hint" />
            <p id="official-school-hint" class="hint">학교 id는 `/api/v1/schools?q=` 또는 위 요청 목록에서 채웁니다(병합된 학교면 정본으로 열림). 대학이 아닌 기관(I-02 기관 페이지, 학과 없음)은 `기관 운영진` 화면에 보이는 기관 id를 씁니다.</p>
          </div>
          <div class="field">
            <label for="official-dept">학과 (선택, 비우면 학교 페이지)</label>
            <input id="official-dept" v-model="form.departmentLabel" maxlength="40" aria-describedby="official-dept-hint" />
            <p id="official-dept-hint" class="hint">학생이 학교 인증에 적은 학과와 띄어쓰기·대소문자를 무시하고 같으면 그 학과로 봅니다.</p>
          </div>
          <div class="field">
            <label for="official-name">이름 (선택, 기본: 학교 이름 + 학과)</label>
            <input id="official-name" v-model="form.name" maxlength="60" />
          </div>
          <div class="field">
            <label for="official-desc">소개 (선택)</label>
            <textarea id="official-desc" v-model="form.description" rows="2" maxlength="300" />
          </div>
          <p class="actions"><button type="submit" :disabled="busy === 'create' || !form.schoolId">공식 페이지 열기</button></p>
        </form>
      </section>

      <section v-if="flags.topics" aria-labelledby="op-topic">
        <h2 id="op-topic">토픽 열기</h2>
        <p class="hint">학교를 넘나드는 공간입니다. 기관 인증이 있으면 누구나 읽고 쓰며, 글에는 이름 대신 소속 표시(인증 회원이 적으면 넓은 범주)만 보입니다.</p>
        <form class="stack" novalidate @submit.prevent="createTopic">
          <div class="field">
            <label for="topic-category">분류</label>
            <select id="topic-category" v-model="topicForm.category">
              <option v-for="(label, key) in TOPIC_CATEGORY_TEXT" :key="key" :value="key">{{ label }}</option>
            </select>
          </div>
          <div class="field">
            <label for="topic-name">이름</label>
            <input id="topic-name" v-model="topicForm.name" maxlength="40" />
          </div>
          <div class="field">
            <label for="topic-desc">소개 (선택)</label>
            <textarea id="topic-desc" v-model="topicForm.description" rows="2" maxlength="300" />
          </div>
          <p class="actions"><button type="submit" :disabled="busy === 'topic' || !topicForm.name.trim()">토픽 열기</button></p>
        </form>
      </section>

      <section aria-labelledby="op-spaces">
        <h2 id="op-spaces">공간</h2>
        <div class="field">
          <label for="op-space-status">상태</label>
          <select id="op-space-status" v-model="statusFilter">
            <option value="">전체</option>
            <option value="active">운영 중</option>
            <option value="restricted">제한됨</option>
            <option value="archived">보관됨</option>
          </select>
        </div>
        <ul v-if="spaces?.length" class="plain operator-list">
          <li v-for="s in spaces" :key="s.id">
            <p>
              <strong>{{ s.name }}</strong>
              <span class="badge">{{ SPACE_KIND_LABELS[s.kind] }}</span>
              <span class="badge">{{ SPACE_STATUS_LABELS[s.status] }}</span>
              <span v-if="s.capacityRequested" class="badge">정원 검토 요청 {{ s.capacityRequested }}명</span>
            </p>
            <p class="small muted">{{ s.school?.name ?? '학교 무관' }} · 멤버 {{ s.memberCount }}명 · 이름 표시 {{ NAME_MODE_LABELS[s.nameMode] }} · <span class="mono">{{ s.id }}</span></p>
            <p class="actions">
              <button v-if="s.status === 'active'" type="button" class="secondary" :disabled="busy === s.id" @click="spaceAction(s, 'restrict')">제한</button>
              <button v-if="s.status === 'restricted'" type="button" class="secondary" :disabled="busy === s.id" @click="spaceAction(s, 'lift-restriction')">제한 해제</button>
              <button v-if="s.status !== 'archived'" type="button" class="link-button" :disabled="busy === s.id" @click="spaceAction(s, 'archive')">보관</button>
              <button v-if="s.capacityRequested" type="button" class="link-button" :disabled="busy === s.id" @click="decideCapacity(s)">정원 정하기</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">공간이 없습니다.</p>
      </section>
    </template>
  </div>
</template>
