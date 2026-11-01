<script setup lang="ts">
/**
 * 학교 메일 인증(C-01, PROOFU_EVOLUTION_PLAN §8.6, ADR 0018).
 * - 학교를 고르고 학교 메일 주소를 넣으면 6자리 코드를 보냅니다(10분, 5번 틀리면 잠김). 코드를 넣으면 인증됩니다.
 * - 메일 주소는 저장하지 않습니다(중복 확인용 해시와 도메인만). 학번은 받지 않고, 학과는 자기 신고(선택)이며 공개하지 않습니다.
 * - 인증하면 그 학교 과목 허브에 선배 노트를 쓸 수 있습니다. 졸업해 메일이 없어져도 인증은 유지되고, 졸업생으로 바꿀 수 있습니다.
 * - 공개 프로필 배지("○○대학교 인증", 졸업생 표시)는 켤 때만 보입니다.
 * `?school=<id>&schoolName=<이름>&return=<경로>`로 오면 학교를 미리 고르고, 인증 뒤 돌아갈 링크를 보여 줍니다.
 * I-01(ADR 0037): P2 플래그 institutions가 켜져 있을 때만 "부트캠프·교육기관 인증"(초대 코드·기수 승인·수료증 확인) 섹션을 보여 줍니다.
 */
import type {
  AffiliationDto,
  AffiliationListDto,
  AffiliationStanding,
  CertificateRequestDto,
  InstitutionDto,
  MeDto,
  SchoolDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '학교 인증 — Peerchive' })

const route = useRoute()
const { me } = useAuth()
const returnTo = computed(() => safeReturnPath(route.query.return))

const { data: list, refresh } = await useAsyncData('my-affiliations', () => useRequestFetch()<AffiliationListDto>('/api/v1/me/affiliations'))
const { flags, ensure: ensureFeatures } = useFeatures()
await ensureFeatures()
const items = computed(() => list.value?.items ?? [])
const hasActive = computed(() => items.value.some((i) => i.status === 'active'))

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)

// ── 새 인증 요청 ──
const presetId = typeof route.query.school === 'string' ? route.query.school : ''
const presetName = typeof route.query.schoolName === 'string' ? route.query.schoolName : ''
const school = ref<SchoolDto | null>(presetId ? { id: presetId, name: presetName || '고른 학교' } : null)
const schoolQuery = ref('')
const schoolResults = ref<SchoolDto[]>([])
const searched = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
function scheduleSearch() {
  clearTimeout(timer)
  timer = setTimeout(() => void searchSchools(), 250)
}
async function searchSchools() {
  try {
    schoolResults.value = schoolQuery.value.trim() ? await $fetch<SchoolDto[]>('/api/v1/schools', { query: { q: schoolQuery.value } }) : []
    searched.value = true
  } catch {
    notice.value = { kind: 'error', text: '학교를 검색하지 못했습니다. 다시 시도하세요.' }
  }
}
function chooseSchool(value: SchoolDto | null) {
  school.value = value
  schoolResults.value = []
  schoolQuery.value = ''
  searched.value = false
}

const form = reactive({ email: '', standing: 'student' as AffiliationStanding, departmentLabel: '' })
const requestErrors = ref<Record<string, string>>({})

async function requestCode() {
  if (!school.value) return
  busy.value = 'request'
  notice.value = null
  requestErrors.value = {}
  try {
    const created = await $fetch<AffiliationDto>('/api/v1/me/affiliations', {
      method: 'POST',
      body: { schoolId: school.value.id, email: form.email, standing: form.standing, departmentLabel: form.departmentLabel || null },
    })
    notice.value = { kind: 'ok', text: `인증 코드를 보냈습니다. 메일함을 확인하고 10분 안에 아래에 입력하세요.` }
    form.email = ''
    await refresh()
    await nextTick()
    document.getElementById(`code-${created.id}`)?.focus()
  } catch (error) {
    const e = apiError(error)
    requestErrors.value = e.code === 'domain_not_allowed' ? {} : e.fields
    notice.value = { kind: 'error', text: e.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : affiliationErrorMessage(e.code) }
  } finally {
    busy.value = null
  }
}

// ── 코드 확인 ──
const codes = reactive<Record<string, string>>({})
async function verify(item: AffiliationDto) {
  busy.value = item.id
  notice.value = null
  try {
    await $fetch(`/api/v1/me/affiliations/${item.id}/verify`, { method: 'POST', body: { code: codes[item.id] ?? '' } })
    codes[item.id] = ''
    notice.value = { kind: 'ok', text: `${item.school.name} 인증을 마쳤습니다. 이제 이 학교 과목 허브에 선배 노트를 쓸 수 있습니다.` }
  } catch (error) {
    const e = apiError(error)
    if (e.code === 'code_mismatch') {
      notice.value = { kind: 'error', text: `인증 코드가 맞지 않습니다. 남은 시도 ${e.data.attemptsLeft ?? 0}회.` }
    } else if (e.code === 'validation_failed') {
      notice.value = { kind: 'error', text: '6자리 숫자 코드를 입력하세요.' }
    } else {
      notice.value = { kind: 'error', text: affiliationErrorMessage(e.code) }
    }
  } finally {
    busy.value = null
    await refresh()
  }
}

// ── 고치기·해제 ──
const edits = reactive<Record<string, { standing: AffiliationStanding; departmentLabel: string }>>({})
watch(
  items,
  (value) => {
    for (const item of value) {
      if (item.status === 'active' && !edits[item.id]) edits[item.id] = { standing: item.standing, departmentLabel: item.departmentLabel ?? '' }
    }
  },
  { immediate: true },
)
const editFor = (item: AffiliationDto) => edits[item.id] ?? { standing: item.standing, departmentLabel: item.departmentLabel ?? '' }
async function saveEdit(item: AffiliationDto) {
  const edit = editFor(item)
  busy.value = item.id
  notice.value = null
  try {
    await $fetch(`/api/v1/me/affiliations/${item.id}`, {
      method: 'PATCH',
      body: { standing: edit.standing, departmentLabel: edit.departmentLabel || null },
    })
    notice.value = { kind: 'ok', text: '저장했습니다.' }
    delete edits[item.id]
    await refresh()
  } catch (error) {
    const e = apiError(error)
    notice.value = { kind: 'error', text: e.fields.departmentLabel ? `학과: ${fieldMessage(e.fields.departmentLabel)}` : affiliationErrorMessage(e.code) }
  } finally {
    busy.value = null
  }
}
async function remove(item: AffiliationDto) {
  const question =
    item.status === 'active'
      ? `${item.school.name} 인증을 해제할까요? 이 학교 과목 허브에 새 글을 쓸 수 없게 됩니다. 이미 게시한 노트는 그대로 남습니다.`
      : '이 요청을 취소할까요?'
  if (!window.confirm(question)) return
  busy.value = item.id
  notice.value = null
  try {
    await $fetch(`/api/v1/me/affiliations/${item.id}`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: item.status === 'active' ? '인증을 해제했습니다.' : '요청을 취소했습니다.' }
    await refresh()
  } catch (error) {
    notice.value = { kind: 'error', text: affiliationErrorMessage(apiError(error).code) }
  } finally {
    busy.value = null
  }
}

// ── 공개 배지 ──
const showBadge = ref(list.value?.showBadge ?? false)
watch(
  () => list.value?.showBadge,
  (value) => {
    if (value !== undefined) showBadge.value = value
  },
)
async function saveBadge() {
  busy.value = 'badge'
  notice.value = null
  try {
    me.value = await $fetch<MeDto>('/api/v1/me/profile', { method: 'PATCH', body: { showAffiliationBadge: showBadge.value } })
    notice.value = { kind: 'ok', text: showBadge.value ? '공개 프로필에 학교 인증 배지를 보입니다.' : '공개 프로필에서 학교 인증 배지를 숨겼습니다.' }
    await refresh()
  } catch {
    showBadge.value = list.value?.showBadge ?? false
    notice.value = { kind: 'error', text: '설정을 바꾸지 못했습니다. 다시 시도하세요.' }
  } finally {
    busy.value = null
  }
}

const expired = (item: AffiliationDto) => !item.code || new Date(item.code.expiresAt).getTime() <= Date.now()

// ── 부트캠프·교육기관 인증(I-01, 플래그 institutions) ──
type InstitutionMethodChoice = 'invite_code' | 'cohort_approval' | 'certificate_check'
const instMethod = ref<InstitutionMethodChoice>('invite_code')
const inst = reactive({ code: '', standing: 'student' as AffiliationStanding, cohortLabel: '' })
const instErrors = ref<Record<string, string>>({})
const institution = ref<InstitutionDto | null>(null)
const institutionQuery = ref('')
const institutionResults = ref<InstitutionDto[]>([])
const institutionSearched = ref(false)
const certificateFile = ref<File | null>(null)
let instTimer: ReturnType<typeof setTimeout> | undefined
function scheduleInstitutionSearch() {
  clearTimeout(instTimer)
  instTimer = setTimeout(() => void searchInstitutions(), 250)
}
async function searchInstitutions() {
  try {
    institutionResults.value = institutionQuery.value.trim()
      ? await $fetch<InstitutionDto[]>('/api/v1/institutions', { query: { q: institutionQuery.value } })
      : []
    institutionSearched.value = true
  } catch {
    notice.value = { kind: 'error', text: '기관을 검색하지 못했습니다. 다시 시도하세요.' }
  }
}
function chooseInstitution(value: InstitutionDto | null) {
  institution.value = value
  institutionResults.value = []
  institutionQuery.value = ''
  institutionSearched.value = false
}
function onCertificateFile(event: Event) {
  certificateFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}
const siteOrigin = useRequestURL().origin
const approvalLink = (item: AffiliationDto) => `${siteOrigin}/affiliations/approve/${item.id}`

async function submitInstitution() {
  busy.value = 'institution'
  notice.value = null
  instErrors.value = {}
  try {
    if (instMethod.value === 'invite_code') {
      const created = await $fetch<AffiliationDto>('/api/v1/me/affiliations/invite-code', { method: 'POST', body: { code: inst.code, standing: inst.standing } })
      notice.value = { kind: 'ok', text: `${created.school.name} 인증을 마쳤습니다.` }
      inst.code = ''
    } else if (instMethod.value === 'cohort_approval') {
      if (!institution.value) return
      await $fetch<AffiliationDto>('/api/v1/me/affiliations/cohort-approval', {
        method: 'POST',
        body: { institutionId: institution.value.id, cohortLabel: inst.cohortLabel, standing: inst.standing },
      })
      notice.value = { kind: 'ok', text: '기수 승인을 요청했습니다. 아래 승인 링크를 같은 기수 멤버 2명에게 직접 보내세요.' }
    } else {
      if (!institution.value || !certificateFile.value) return
      const file = certificateFile.value
      const created = await $fetch<CertificateRequestDto>('/api/v1/me/affiliations/certificate', {
        method: 'POST',
        body: {
          institutionId: institution.value.id,
          standing: inst.standing,
          cohortLabel: inst.cohortLabel || null,
          declaredType: file.type,
          fileName: file.name,
          byteSize: file.size,
        },
      })
      await $fetch(created.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } })
      notice.value = { kind: 'ok', text: '수료증을 올렸습니다. 운영자가 확인하면 결과가 여기에 보입니다. 파일은 결정 뒤 바로 지웁니다.' }
      certificateFile.value = null
    }
    await refresh()
  } catch (error) {
    const e = apiError(error)
    instErrors.value = e.fields
    notice.value = { kind: 'error', text: e.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : affiliationErrorMessage(e.code) }
  } finally {
    busy.value = null
  }
}
const instReady = computed(() =>
  instMethod.value === 'invite_code'
    ? !!inst.code.trim()
    : instMethod.value === 'cohort_approval'
      ? !!institution.value && !!inst.cohortLabel.trim()
      : !!institution.value && !!certificateFile.value,
)
</script>

<template>
  <div class="affiliation-page">
    <h1>학교 인증</h1>
    <p class="hint">
      학교 메일로 인증하면 그 학교 과목 허브에 선배 노트를 쓸 수 있습니다. 과목 허브를 읽거나 계획을 포크하는 데는 인증이 필요 없습니다.
      메일 주소는 저장하지 않고(같은 주소의 중복 인증을 막는 해시와 도메인만), 학번은 받지 않으며, 학과는 공개되지 않습니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p v-if="returnTo && hasActive" class="notice ok"><NuxtLink :to="returnTo">선배 노트 쓰러 돌아가기</NuxtLink></p>

    <section aria-labelledby="my-affiliations">
      <h2 id="my-affiliations">내 학교 인증</h2>
      <ul v-if="items.length" class="plain hub-list">
        <li v-for="item in items" :key="item.id" class="hub-card">
          <p>
            <strong>{{ item.school.name }}</strong>
            <span class="badge">{{ affiliationStatusLabel(item) }}</span>
            <span class="badge">{{ standingLabelFor(item.institutionKind, item.standing) }}</span>
            <span v-if="item.method !== 'email'" class="badge">{{ AFFILIATION_METHOD_LABELS[item.method] }}</span>
          </p>
          <p class="small muted">
            <template v-if="item.emailDomain">메일 도메인 {{ item.emailDomain }} (나만 봄)</template>
            <template v-else>{{ INSTITUTION_KIND_LABELS[item.institutionKind] }}</template>
            <template v-if="item.cohortLabel"> · 기수 {{ item.cohortLabel }}</template>
            <template v-if="item.verifiedAt"> · 인증 {{ seoulDay(item.verifiedAt) }}</template>
            <template v-if="item.departmentLabel"> · 학과(비공개): {{ item.departmentLabel }}</template>
            <template v-if="item.status === 'revoked' && item.revokedAt"> · {{ affiliationRevokedLabel(item) }} {{ seoulDay(item.revokedAt) }}</template>
          </p>

          <div v-if="item.status === 'pending' && item.method === 'cohort_approval'" class="stack">
            <p class="small">
              승인 {{ item.cohortApprovals?.count ?? 0 }} / {{ item.cohortApprovals?.required ?? 2 }}. 같은 기수에서 초대 코드·수료증으로 인증한 멤버에게 아래 링크를 직접 보내세요.
              기수 승인으로 인증된 멤버의 승인은 세지 않습니다. 30일 안에 승인을 다 받지 못하면 만료됩니다.
            </p>
            <p class="small"><code>{{ approvalLink(item) }}</code></p>
            <p class="actions"><button type="button" class="secondary" :disabled="busy === item.id" @click="remove(item)">요청 취소</button></p>
          </div>
          <div v-else-if="item.status === 'pending' && item.method === 'certificate_check'" class="stack">
            <p class="small">
              <template v-if="!item.certificate?.uploaded">파일을 아직 받지 못했습니다. 요청을 취소하고 다시 올리세요.</template>
              <template v-else>{{ SCAN_STATUS_LABELS[item.certificate.scanStatus] }} · 운영자 확인을 기다립니다. 파일은 결정 뒤 바로 지웁니다.</template>
            </p>
            <p class="actions"><button type="button" class="secondary" :disabled="busy === item.id" @click="remove(item)">요청 취소</button></p>
          </div>
          <form v-else-if="item.status === 'pending'" class="stack" novalidate @submit.prevent="verify(item)">
            <div class="field">
              <label :for="`code-${item.id}`">인증 코드 (6자리)</label>
              <input
                :id="`code-${item.id}`"
                v-model="codes[item.id]"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                pattern="[0-9]{6}"
                class="code-input"
                :aria-describedby="`code-${item.id}-hint`"
              />
              <p :id="`code-${item.id}-hint`" class="hint">
                <template v-if="item.code && !expired(item)">남은 시도 {{ item.code.attemptsLeft }}회 · {{ seoulTime(item.code.expiresAt) }}까지 입력</template>
                <template v-else>코드가 만료되었습니다. 아래에서 코드를 다시 받으세요.</template>
              </p>
            </div>
            <p class="actions">
              <button type="submit" :disabled="busy === item.id">확인</button>
              <button type="button" class="secondary" :disabled="busy === item.id" @click="remove(item)">요청 취소</button>
            </p>
          </form>

          <form v-else-if="item.status === 'active'" class="stack" novalidate @submit.prevent="saveEdit(item)">
            <div class="field">
              <label :for="`standing-${item.id}`">재학 상태</label>
              <select v-if="item.standing === 'student'" :id="`standing-${item.id}`" v-model="editFor(item).standing">
                <option value="student">{{ standingLabelFor(item.institutionKind, 'student') }}</option>
                <option value="alumni">{{ standingLabelFor(item.institutionKind, 'alumni') }}</option>
              </select>
              <p v-else-if="item.institutionKind !== 'university'" :id="`standing-${item.id}`" class="small">수료생</p>
              <p v-else :id="`standing-${item.id}`" class="small">졸업생 (재학생으로 바꾸려면 해제 뒤 재학 중인 메일로 다시 인증하세요)</p>
            </div>
            <div class="field">
              <label :for="`dept-${item.id}`">학과 (선택, 공개되지 않음)</label>
              <input :id="`dept-${item.id}`" v-model="editFor(item).departmentLabel" :maxlength="DEPARTMENT_LABEL_MAX" />
            </div>
            <p class="actions">
              <button type="submit" :disabled="busy === item.id">저장</button>
              <button type="button" class="danger" :disabled="busy === item.id" @click="remove(item)">인증 해제</button>
            </p>
          </form>
        </li>
      </ul>
      <p v-else class="muted">아직 인증한 학교가 없습니다.</p>
    </section>

    <section aria-labelledby="new-affiliation">
      <h2 id="new-affiliation">학교 메일로 인증하기</h2>
      <form class="stack" novalidate @submit.prevent="requestCode">
        <fieldset>
          <legend>학교</legend>
          <p v-if="school" class="actions">
            <strong>{{ school.name }}</strong>
            <button type="button" class="link-button" @click="chooseSchool(null)">다른 학교 고르기</button>
          </p>
          <template v-else>
            <div class="field">
              <label for="affiliation-school-q">학교 검색</label>
              <input
                id="affiliation-school-q"
                v-model="schoolQuery"
                type="search"
                autocomplete="off"
                placeholder="예: 한빛대"
                @input="scheduleSearch"
                @keydown.enter.prevent="searchSchools"
              />
            </div>
            <p class="visually-hidden" role="status">{{ searched ? `학교 ${schoolResults.length}개` : '' }}</p>
            <ul v-if="schoolResults.length" class="plain">
              <li v-for="s in schoolResults" :key="s.id">
                <button type="button" class="secondary" @click="chooseSchool(s)">{{ s.name }}</button>
              </li>
            </ul>
            <p v-else-if="searched && schoolQuery.trim()" class="muted small">찾는 학교가 없습니다.</p>
          </template>
        </fieldset>
        <div class="field">
          <label for="affiliation-email">학교 메일 주소</label>
          <input
            id="affiliation-email"
            v-model="form.email"
            type="email"
            autocomplete="email"
            maxlength="254"
            :aria-invalid="!!requestErrors.email"
            aria-describedby="affiliation-email-hint"
          />
          <p id="affiliation-email-hint" class="hint">학교에서 받은 메일(예: 학번@학교 도메인). 코드를 보낸 뒤 주소는 저장하지 않습니다.</p>
          <p v-if="requestErrors.email" class="field-error">{{ fieldMessage(requestErrors.email) }}</p>
        </div>
        <fieldset>
          <legend>재학 상태</legend>
          <div class="inline-options">
            <label class="check"><input v-model="form.standing" type="radio" name="affiliation-standing" value="student" /> 재학생</label>
            <label class="check"><input v-model="form.standing" type="radio" name="affiliation-standing" value="alumni" /> 졸업생</label>
          </div>
        </fieldset>
        <div class="field">
          <label for="affiliation-dept">학과 (선택, 공개되지 않음)</label>
          <input id="affiliation-dept" v-model="form.departmentLabel" :maxlength="DEPARTMENT_LABEL_MAX" :aria-invalid="!!requestErrors.departmentLabel" />
          <p v-if="requestErrors.departmentLabel" class="field-error">{{ fieldMessage(requestErrors.departmentLabel) }}</p>
        </div>
        <p class="actions">
          <button type="submit" :disabled="!school || !form.email.trim() || busy === 'request'">인증 코드 받기</button>
        </p>
      </form>
    </section>

    <section v-if="flags.institutions" aria-labelledby="institution-affiliation">
      <h2 id="institution-affiliation">부트캠프·교육기관 인증</h2>
      <p class="hint">
        대학이 아닌 기관은 학교 메일 대신 초대 코드, 같은 기수 멤버 2명의 승인, 수료증 확인 중 하나로 인증합니다. 수료증 파일은 운영자만 짧게 보고,
        결정 뒤 바로 지웁니다(삭제 기록만 남음).
      </p>
      <form class="stack" novalidate @submit.prevent="submitInstitution">
        <fieldset>
          <legend>인증 방법</legend>
          <div class="inline-options">
            <label class="check"><input v-model="instMethod" type="radio" name="institution-method" value="invite_code" /> 초대 코드</label>
            <label class="check"><input v-model="instMethod" type="radio" name="institution-method" value="cohort_approval" /> 기수 승인</label>
            <label class="check"><input v-model="instMethod" type="radio" name="institution-method" value="certificate_check" /> 수료증 확인</label>
          </div>
        </fieldset>
        <div v-if="instMethod === 'invite_code'" class="field">
          <label for="institution-code">초대 코드</label>
          <input id="institution-code" v-model="inst.code" autocomplete="off" maxlength="20" placeholder="XXXX-XXXX-XXXX" :aria-invalid="!!instErrors.code" />
          <p v-if="instErrors.code" class="field-error">{{ affiliationErrorMessage(instErrors.code) }}</p>
        </div>
        <fieldset v-else>
          <legend>기관</legend>
          <p v-if="institution" class="actions">
            <strong>{{ institution.name }}</strong> <span class="badge">{{ INSTITUTION_KIND_LABELS[institution.kind] }}</span>
            <button type="button" class="link-button" @click="chooseInstitution(null)">다른 기관 고르기</button>
          </p>
          <template v-else>
            <div class="field">
              <label for="institution-q">기관 검색</label>
              <input id="institution-q" v-model="institutionQuery" type="search" autocomplete="off" @input="scheduleInstitutionSearch" @keydown.enter.prevent="searchInstitutions" />
            </div>
            <p class="visually-hidden" role="status">{{ institutionSearched ? `기관 ${institutionResults.length}개` : '' }}</p>
            <ul v-if="institutionResults.length" class="plain">
              <li v-for="i in institutionResults" :key="i.id">
                <button type="button" class="secondary" @click="chooseInstitution(i)">{{ i.name }} ({{ INSTITUTION_KIND_LABELS[i.kind] }})</button>
              </li>
            </ul>
            <p v-else-if="institutionSearched && institutionQuery.trim()" class="muted small">찾는 기관이 없습니다. 기관은 운영자가 등록합니다.</p>
          </template>
        </fieldset>
        <div v-if="instMethod !== 'invite_code'" class="field">
          <label for="institution-cohort">기수{{ instMethod === 'certificate_check' ? ' (선택)' : '' }}</label>
          <input id="institution-cohort" v-model="inst.cohortLabel" :maxlength="COHORT_LABEL_MAX" placeholder="예: 12기" :aria-invalid="!!instErrors.cohortLabel" />
          <p v-if="instErrors.cohortLabel" class="field-error">{{ fieldMessage(instErrors.cohortLabel) }}</p>
        </div>
        <div v-if="instMethod === 'certificate_check'" class="field">
          <label for="institution-certificate">수료증 파일 (PNG·JPEG·WebP·PDF, 10MB까지)</label>
          <input id="institution-certificate" type="file" :accept="CERTIFICATE_MEDIA_TYPES.join(',')" @change="onCertificateFile" />
          <p class="hint">위치 정보 등 사진 메타데이터는 지우고, 파일 이름은 저장하지 않습니다.</p>
          <p v-if="instErrors.declaredType || instErrors.fileName || instErrors.byteSize" class="field-error">
            PNG·JPEG·WebP·PDF 파일(10MB까지)만 올릴 수 있습니다.
          </p>
        </div>
        <fieldset>
          <legend>상태</legend>
          <div class="inline-options">
            <label class="check"><input v-model="inst.standing" type="radio" name="institution-standing" value="student" /> 수강생</label>
            <label class="check"><input v-model="inst.standing" type="radio" name="institution-standing" value="alumni" /> 수료생</label>
          </div>
        </fieldset>
        <p class="actions">
          <button type="submit" :disabled="!instReady || busy === 'institution'">
            {{ instMethod === 'invite_code' ? '코드로 인증하기' : instMethod === 'cohort_approval' ? '기수 승인 요청하기' : '수료증 올리기' }}
          </button>
        </p>
      </form>
    </section>

    <section aria-labelledby="affiliation-badge">
      <h2 id="affiliation-badge">공개 프로필 배지</h2>
      <p class="hint">켜면 공개 프로필에 "○○대학교 인증"(졸업생이면 "졸업생")만 보입니다. 학과·메일 주소·도메인은 보이지 않습니다.</p>
      <div class="field">
        <label>
          <input v-model="showBadge" type="checkbox" :disabled="!me?.profile || busy === 'badge'" @change="saveBadge" />
          공개 프로필에 학교 인증 배지 보이기
        </label>
        <p v-if="!me?.profile" class="hint">먼저 <NuxtLink to="/onboarding">프로필</NuxtLink>을 만드세요.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.code-input {
  max-width: 10ch;
  letter-spacing: 0.2em;
  font-variant-numeric: tabular-nums;
}
</style>
