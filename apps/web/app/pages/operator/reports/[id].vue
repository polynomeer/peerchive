<script setup lang="ts">
/**
 * 신고 상세·처리(T-15, ADR 0015). 운영자가 아니면 404로 보입니다.
 * - 공개됐던 내용만: 신고 때의 release 스냅샷(PublicSnapshotView), 신고 때 버전 그대로인 노트·케이스 글, 공개 프로필 필드.
 * - 처리: 조치(대상별로 고를 수 있는 것만) + 내부 메모(필수) + 당사자에게 보일 사유(별도) + 당사자 알림. 같은 대상의 처리 전 신고를 함께 닫고 보류를 풉니다.
 * - 기각, 제한 해제(restricted → draft), 이의 결정(유지·되돌림), 감사 기록 보기.
 */
import type {
  ModerationActionKind,
  OperatorAppealDto,
  OperatorAuditEventDto,
  OperatorReportDetailDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '신고 처리 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data, error, refresh } = await useFetch<OperatorReportDetailDto>(() => `/api/v1/operator/reports/${id.value}`)
if (import.meta.server && error.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const open = computed(() => data.value?.report.status === 'open' || data.value?.report.status === 'in_review')
const form = reactive({ action: 'none' as ModerationActionKind, note: '', publicReason: '', notifyOwner: true })
const dismissNote = ref('')
const liftNote = ref('')
const decide = reactive<Record<string, { decision: 'uphold' | 'reverse'; note: string }>>({})
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const fieldErrors = ref<Record<string, string>>({})
const busy = ref(false)
const audit = ref<OperatorAuditEventDto[] | null>(null)

const contentFocus = computed(() => {
  const c = data.value?.content
  if (!c || c.kind !== 'release' || !c.focus) return null
  const s = c.snapshot
  const f = c.focus
  if (f.kind === 'log') {
    const log = s.logs.find((l) => l.key === f.key)
    return log ? `${LOG_TAG_LABELS[log.tag]} — ${log.body || JSON.stringify(log.payload)}` : '(스냅샷에 없음)'
  }
  if (f.kind === 'claim') return s.claims.find((x) => x.key === f.key)?.text ?? '(스냅샷에 없음)'
  return s.artifacts.find((a) => a.artifactVersionId === f.key)?.displayName ?? '(스냅샷에 없음)'
})

async function call<T>(url: string, body: Record<string, unknown>, ok: string): Promise<T | null> {
  message.value = null
  fieldErrors.value = {}
  busy.value = true
  try {
    const result = await $fetch<T>(url, { method: 'POST', body })
    message.value = { kind: 'ok', text: ok }
    await refresh()
    return result
  } catch (e) {
    const err = apiError(e)
    fieldErrors.value = err.fields
    message.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력을 확인하세요.' : moderationErrorMessage(err.code) }
    return null
  } finally {
    busy.value = false
  }
}

const assign = () => call(`/api/v1/operator/reports/${id.value}/assign`, {}, '나에게 배정했습니다.')
async function resolve() {
  const done = await call(
    `/api/v1/operator/reports/${id.value}/resolve`,
    { action: form.action, note: form.note, publicReason: form.publicReason || null, notifyOwner: form.notifyOwner },
    '처리했습니다.',
  )
  if (done) Object.assign(form, { action: 'none', note: '', publicReason: '' })
}
const dismiss = () => call(`/api/v1/operator/reports/${id.value}/dismiss`, { note: dismissNote.value }, '기각했습니다.')
const lift = () => call(`/api/v1/operator/publications/${data.value!.publication!.id}/lift-restriction`, { note: liftNote.value }, '제한을 풀었습니다. owner가 새 후보로 다시 게시해야 합니다.')
function decideFor(appealId: string) {
  decide[appealId] ??= { decision: 'uphold', note: '' }
  return decide[appealId]
}
const decideAppeal = (appealId: string) =>
  call<OperatorAppealDto>(`/api/v1/operator/appeals/${appealId}/decide`, { ...decideFor(appealId) }, '이의제기를 결정했습니다.')

async function loadAudit() {
  const target = data.value?.publication?.id ?? id.value
  try {
    audit.value = await $fetch<OperatorAuditEventDto[]>('/api/v1/operator/audit', { query: { target } })
  } catch (e) {
    message.value = { kind: 'error', text: moderationErrorMessage(apiError(e).code) }
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="error || !data">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <p><NuxtLink to="/operator">← 신고 대기열</NuxtLink></p>
      <h1>{{ data.targetLabel || REPORT_TARGET_LABELS[data.targetType] }}</h1>
      <p class="actions small">
        <span class="badge">{{ REPORT_TARGET_LABELS[data.targetType] }}</span>
        <span class="badge" :class="{ embargo: !data.servedNow }">{{ data.servedNow ? '지금 공개 중' : '지금 공개되지 않음' }}</span>
        <span v-if="data.publication" class="badge">공개 상태: {{ PUBLICATION_STATUS_LABELS[data.publication.status] }}</span>
        <NuxtLink v-if="data.publicPath" :to="data.publicPath" target="_blank" rel="noopener">공개 화면 열기</NuxtLink>
      </p>
      <p v-if="message" :class="['notice', message.kind]" :role="message.kind === 'error' ? 'alert' : 'status'">{{ message.text }}</p>

      <section aria-labelledby="op-reports">
        <h2 id="op-reports">신고 {{ data.reports.length }}건</h2>
        <p class="small">담당: {{ data.assignee?.displayName || '없음' }}</p>
        <p v-if="open" class="actions"><button type="button" class="secondary" :disabled="busy" @click="assign">나에게 배정</button></p>
        <ul class="plain operator-list">
          <li v-for="r in data.reports" :key="r.id">
            <p>
              <strong>{{ REPORT_REASON_LABELS[r.reason] }}</strong>
              <span class="badge">{{ r.status }}</span>
              <span class="small muted"> · {{ formatDateTime(r.createdAt) }}</span>
            </p>
            <p v-if="r.details" class="small pre">{{ r.details }}</p>
          </li>
        </ul>
        <p v-if="data.holds.length" class="small">
          보류: <template v-for="(h, i) in data.holds" :key="i">{{ REPORT_REASON_LABELS[h.reason] }}({{ h.releasedAt ? '풀림' : '걸림' }}) </template>
        </p>
      </section>

      <section aria-labelledby="op-content">
        <h2 id="op-content">공개됐던 내용</h2>
        <template v-if="data.content.kind === 'release'">
          <p class="small muted">신고 때 제공하던 공개 버전 v{{ data.content.releaseVersion }}의 저장된 스냅샷입니다.</p>
          <p v-if="contentFocus" class="notice"><strong>신고된 항목:</strong> <span class="pre">{{ contentFocus }}</span></p>
          <p v-if="data.content.hiddenKeys.length" class="small">지금 가려진 항목: {{ data.content.hiddenKeys.join(', ') }}</p>
          <details>
            <summary>스냅샷 전체 보기</summary>
            <PublicSnapshotView :snapshot="data.content.snapshot" id-prefix="op" />
          </details>
        </template>
        <template v-else-if="data.content.kind === 'senior_note'">
          <p class="small muted">{{ data.content.note.author }} · {{ data.content.note.termLabel }}</p>
          <dl class="note-answers">
            <template v-for="q in SENIOR_NOTE_QUESTIONS" :key="q">
              <template v-if="data.content.note.answers[q]">
                <dt>{{ SENIOR_NOTE_QUESTION_LABELS[q] }}</dt>
                <dd class="pre">{{ data.content.note.answers[q] }}</dd>
              </template>
            </template>
          </dl>
        </template>
        <template v-else-if="data.content.kind === 'case_study'">
          <h3>{{ data.content.title }}</h3>
          <section v-for="s in data.content.sections" :key="s.key">
            <h4>{{ s.label }}</h4>
            <ul>
              <li v-for="(x, i) in s.sentences" :key="i">{{ x.text }} <span class="small muted">({{ x.citations.join(', ') || '출처 없음' }})</span></li>
            </ul>
          </section>
        </template>
        <template v-else-if="data.content.kind === 'profile'">
          <p><strong>{{ data.content.profile.displayName }}</strong> @{{ data.content.profile.handle }}</p>
          <p v-if="data.content.profile.headline" class="pre">{{ data.content.profile.headline }}</p>
          <p class="small muted">{{ data.content.profile.schoolLabel }} {{ data.content.profile.gradTerm }}</p>
        </template>
        <template v-else-if="data.content.kind === 'community_space'">
          <p>
            <strong>{{ data.content.space.name }}</strong>
            <span class="badge">{{ SPACE_KIND_LABELS[data.content.space.kind] }}</span>
            <span class="badge">{{ SPACE_STATUS_LABELS[data.content.space.status] }}</span>
          </p>
          <p v-if="data.content.space.description" class="pre">{{ data.content.space.description }}</p>
          <p class="small muted">
            {{ data.content.space.school?.name ?? '학교 무관' }} · 멤버 {{ data.content.space.memberCount }}명 ·
            {{ NAME_MODE_LABELS[data.content.space.nameMode] }} · {{ JOIN_POLICY_LABELS[data.content.space.joinPolicy] }}
          </p>
          <p class="hint">운영자에게도 게시판 글·멤버 목록은 보이지 않습니다. 제한하면 멤버는 읽기만 하고 목록·가입·쓰기가 멈춥니다.</p>
        </template>
        <p v-else class="muted">{{ data.content.message }}</p>
      </section>

      <section v-if="open" aria-labelledby="op-resolve">
        <h2 id="op-resolve">처리</h2>
        <form class="stack" @submit.prevent="resolve">
          <div class="field">
            <label for="op-action">조치</label>
            <select id="op-action" v-model="form.action">
              <option v-for="a in data.allowedActions" :key="a" :value="a">{{ ACTION_LABELS[a] }}</option>
            </select>
            <p class="hint">조치는 공개를 막을 뿐 삭제하지 않습니다. 공개 사례 전체 비공개는 owner가 새 후보·동의·게시를 다시 해야 풀립니다.</p>
          </div>
          <div class="field">
            <label for="op-note">내부 메모(필수, 운영자만 봄)</label>
            <textarea id="op-note" v-model="form.note" rows="3" maxlength="1000" required aria-describedby="op-note-error" />
            <p v-if="fieldErrors.note" id="op-note-error" class="field-error">{{ fieldMessage(fieldErrors.note) }}</p>
          </div>
          <div class="field">
            <label for="op-public">당사자에게 보일 사유</label>
            <input id="op-public" v-model="form.publicReason" type="text" maxlength="300" aria-describedby="op-public-hint" />
            <p id="op-public-hint" class="hint">내부 메모와 별도입니다. 신고자·신고 내용은 적지 마세요. 알림을 켜면 필수입니다.</p>
            <p v-if="fieldErrors.publicReason" class="field-error">{{ fieldMessage(fieldErrors.publicReason) }}</p>
          </div>
          <label><input v-model="form.notifyOwner" type="checkbox" /> 당사자에게 알림(내 알림 목록)</label>
          <p v-if="fieldErrors.action" class="field-error">이 대상에는 쓸 수 없는 조치입니다.</p>
          <p class="actions"><button type="submit" :disabled="busy">처리하기</button></p>
        </form>
        <form class="stack" @submit.prevent="dismiss">
          <div class="field">
            <label for="op-dismiss">기각 메모(필수)</label>
            <textarea id="op-dismiss" v-model="dismissNote" rows="2" maxlength="1000" required />
          </div>
          <p class="actions"><button type="submit" class="secondary" :disabled="busy">기각하기</button></p>
        </form>
      </section>

      <section v-if="data.publication?.status === 'restricted'" aria-labelledby="op-lift">
        <h2 id="op-lift">운영 제한 해제</h2>
        <form class="stack" @submit.prevent="lift">
          <div class="field">
            <label for="op-lift-note">해제 메모(필수)</label>
            <textarea id="op-lift-note" v-model="liftNote" rows="2" maxlength="1000" required />
            <p class="hint">해제하면 초안 상태가 됩니다. 이전 공개 버전은 되살아나지 않고, owner가 새 후보를 만들어 동의를 다시 받아야 합니다.</p>
          </div>
          <p class="actions"><button type="submit" class="secondary" :disabled="busy">제한 해제</button></p>
        </form>
      </section>

      <section aria-labelledby="op-history">
        <h2 id="op-history">조치·이의제기 이력</h2>
        <ul v-if="data.actions.length" class="plain operator-list">
          <li v-for="a in data.actions" :key="a.id">
            <p>
              <strong>{{ ACTION_LABELS[a.kind] }}</strong> · {{ a.outcome === 'dismissed' ? '기각' : '처리' }}
              <span class="small muted"> · {{ a.createdBy }} · {{ formatDateTime(a.createdAt) }}</span>
              <span v-if="a.reversedAt" class="badge">풀림({{ a.reverseCause === 'appeal' ? '이의제기' : '제한 해제' }})</span>
            </p>
            <p class="small pre">내부 메모: {{ a.internalNote }}</p>
            <p v-if="a.publicReason" class="small">당사자 사유: {{ a.publicReason }}<template v-if="a.notifyOwner"> (알림)</template></p>
            <p v-if="a.reverseNote" class="small pre">해제 메모: {{ a.reverseNote }}</p>
            <template v-if="a.appeal">
              <p class="small"><strong>이의제기</strong> · {{ APPEAL_STATUS_LABELS[a.appeal.status] }} · {{ formatDateTime(a.appeal.createdAt) }}</p>
              <p class="small pre">“{{ a.appeal.message }}”</p>
              <p v-if="a.appeal.decisionNote" class="small pre">결정 메모: {{ a.appeal.decisionNote }}</p>
              <form v-if="a.appeal.status === 'open'" class="stack" @submit.prevent="decideAppeal(a.appeal.id)">
                <fieldset>
                  <legend>결정</legend>
                  <label><input v-model="decideFor(a.appeal.id).decision" type="radio" value="uphold" :name="`d-${a.appeal.id}`" /> 조치 유지</label>
                  <label><input v-model="decideFor(a.appeal.id).decision" type="radio" value="reverse" :name="`d-${a.appeal.id}`" /> 되돌리기(조치 풀기)</label>
                </fieldset>
                <div class="field">
                  <label :for="`d-note-${a.appeal.id}`">결정 메모(필수)</label>
                  <textarea :id="`d-note-${a.appeal.id}`" v-model="decideFor(a.appeal.id).note" rows="2" maxlength="1000" required />
                </div>
                <p class="actions"><button type="submit" :disabled="busy">결정하기</button></p>
              </form>
            </template>
          </li>
        </ul>
        <p v-else class="muted">아직 조치가 없습니다.</p>
      </section>

      <section aria-labelledby="op-audit">
        <h2 id="op-audit">감사 기록</h2>
        <p><button type="button" class="secondary" @click="loadAudit">감사 기록 불러오기</button></p>
        <table v-if="audit" class="operator-table">
          <caption class="visually-hidden">감사 기록</caption>
          <thead>
            <tr><th scope="col">시각</th><th scope="col">행동</th><th scope="col">대상</th><th scope="col">정보</th></tr>
          </thead>
          <tbody>
            <tr v-for="e in audit" :key="e.id">
              <td>{{ formatDateTime(e.at) }}</td>
              <td>{{ e.action }}</td>
              <td>{{ e.targetType }}</td>
              <td class="small mono">{{ JSON.stringify(e.metadata) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </div>
</template>
