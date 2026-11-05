<script setup lang="ts">
/**
 * 모집 상세(C-07, ADR 0024). 로그인 전용·noindex·제목 고정(C-05).
 * - 지원: 메시지(선택)와 내 공개 프로필·내가 팀원인 공개 사례 링크(선택)를 붙여 지원. 지원하면 모집자에게 내 표시 이름이 보입니다.
 * - 내 지원: 상태만(거절과 마감은 같은 문장). 선정 + 마감이면 "초대 받기" → 기존 초대 화면에서 본인이 수락해야 멤버가 됩니다.
 * - 모집자: 지원 목록(지원 시각 순서만, 순위·활동량 없음)·선정·선정 안 함(사유 없음)·마감(과제 공간/스터디 방 링크)·취소.
 */
import type {
  ApplicationAttachmentOptionsDto,
  MyApplicationDto,
  RecruitmentApplicationDto,
  RecruitmentDetailDto,
  RecruitmentLockedDto,
  RecruitmentInvitationDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const fetcher = useRequestFetch()
const { data: fetched, error, refresh } = await useAsyncData(`recruitment-${id.value}`, () => fetcher<RecruitmentDetailDto | RecruitmentLockedDto>(`/api/v1/community/recruitments/${id.value}`))
// 과목을 등록하지 않은 인증 사용자에게는 내용 없이 안내만 옵니다(ADR 0060 D-05).
const locked = computed(() => !!fetched.value && 'registrationRequired' in fetched.value)
const data = computed(() => (fetched.value && !('registrationRequired' in fetched.value) ? fetched.value : null))
const missing = computed(() => !!error.value || !fetched.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const isRecruiter = computed(() => !!data.value?.recruiter)
/** 모집자 화면의 상태 글자(거절 사유 없음). */
const RECRUITER_STATUS_TEXT = { pending: '검토 중', accepted: '선정', declined: '선정 안 함', withdrawn: '지원 취소' } as const
const applications = ref<RecruitmentApplicationDto[]>([])
const options = ref<ApplicationAttachmentOptionsDto | null>(null)
const busy = ref<string | null>(null)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const invite = ref<RecruitmentInvitationDto | null>(null)
const form = reactive({ message: '', attachProfile: false, caseSlugs: [] as string[] })
const fieldErrors = ref<Record<string, string>>({})

async function loadApplications() {
  if (!isRecruiter.value) return
  try {
    applications.value = await $fetch<RecruitmentApplicationDto[]>(`/api/v1/community/recruitments/${id.value}/applications`)
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  }
}

async function loadOptions() {
  if (!data.value?.canApply) return
  try {
    options.value = await $fetch<ApplicationAttachmentOptionsDto>('/api/v1/community/recruitments/attachment-options')
  } catch {
    options.value = { profile: null, cases: [] }
  }
}

onMounted(() => {
  void loadApplications()
  void loadOptions()
})
watch(isRecruiter, () => void loadApplications())

async function run(key: string, fn: () => Promise<unknown>, ok: string) {
  busy.value = key
  notice.value = null
  try {
    await fn()
    notice.value = { kind: 'ok', text: ok }
    await refresh()
    await loadApplications()
  } catch (e) {
    const err = apiError(e)
    fieldErrors.value = err.fields
    notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
    await refresh()
  } finally {
    busy.value = null
  }
}

function apply() {
  fieldErrors.value = {}
  return run(
    'apply',
    () =>
      $fetch<MyApplicationDto>(`/api/v1/community/recruitments/${id.value}/applications`, {
        method: 'POST',
        body: { message: form.message, attachProfile: form.attachProfile, caseSlugs: form.caseSlugs },
      }),
    '지원했습니다. 결과는 이 화면과 커뮤니티 알림에서 볼 수 있습니다.',
  )
}
const withdraw = () => run('withdraw', () => $fetch<unknown>(`/api/v1/community/recruitments/${id.value}/withdraw`, { method: 'POST' }), '지원을 취소했습니다.')
const accept = (appId: string) => run(`accept-${appId}`, () => $fetch<unknown>(`/api/v1/community/recruitments/${id.value}/applications/${appId}/accept`, { method: 'POST' }), '선정했습니다.')
const decline = (appId: string) =>
  run(`decline-${appId}`, () => $fetch<unknown>(`/api/v1/community/recruitments/${id.value}/applications/${appId}/decline`, { method: 'POST' }), '선정하지 않았습니다. 지원자에게는 사유 없이 결과만 알립니다.')
const close = () => run('close', () => $fetch<unknown>(`/api/v1/community/recruitments/${id.value}/close`, { method: 'POST' }), '모집을 마감했습니다. 선정한 사람에게 초대 알림을 보냈습니다.')
const cancel = () => run('cancel', () => $fetch<unknown>(`/api/v1/community/recruitments/${id.value}/cancel`, { method: 'POST' }), '모집을 취소했습니다. 지원자에게 알렸습니다.')

async function getInvitation() {
  busy.value = 'invite'
  notice.value = null
  try {
    invite.value = await $fetch<RecruitmentInvitationDto>(`/api/v1/community/recruitments/${id.value}/invitation`, { method: 'POST' })
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  } finally {
    busy.value = null
  }
}

const invitePath = computed(() => (invite.value ? new URL(invite.value.inviteUrl).pathname : ''))
const resultLink = computed(() => {
  const r = data.value?.recruiter?.result
  if (r?.projectId) return { to: `/projects/${r.projectId}`, label: '만들어진 팀 과제 공간(비공개) 열기' }
  if (r?.spaceSlug) return { to: `/community/s/${r.spaceSlug}`, label: '만들어진 스터디 방 열기' }
  return null
})
const reportTargets = computed(() => (data.value ? [{ id: data.value.id, label: '이 모집 글', targetType: 'community_recruitment' as const, targetRef: { recruitmentId: data.value.id } }] : []))
</script>

<template>
  <div class="community-page recruitment-page">
    <template v-if="missing">
      <h1>모집을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 모집을 볼 수 있는 학교 인증·멤버십이 없습니다.</p>
      <p><NuxtLink to="/community/recruitments">내 모집·내 지원</NuxtLink></p>
    </template>
    <template v-else-if="locked">
      <h1>모집</h1>
      <p class="notice" role="status" data-testid="recruitment-registration-required">과목을 등록하면 볼 수 있습니다. <NuxtLink to="/me/courses">내 과목에서 등록하기</NuxtLink></p>
    </template>
    <template v-else-if="data">
      <p class="small">
        <NuxtLink v-if="data.space" :to="`/community/recruitments?space=${data.space.slug}`">{{ data.space.name }} 모집</NuxtLink>
        <NuxtLink v-else-if="data.course" :to="`/community/recruitments?course=${data.course.id}`">{{ data.course.title }} 모집</NuxtLink>
      </p>
      <p>
        <span class="badge" data-testid="recruitment-kind">{{ RECRUITMENT_KIND_LABELS[data.kind] }}</span>
        <span class="badge" data-testid="recruitment-status">{{ RECRUITMENT_STATUS_LABELS[data.status] }}</span>
        <span v-if="data.hidden" class="badge">운영 조치로 가려짐(나만 보임)</span>
      </p>
      <h1>{{ data.title }}</h1>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'" data-testid="recruitment-notice">{{ notice.text }}</p>
      <p class="small muted">
        <template v-if="data.course">{{ data.course.schoolName }} · {{ data.course.title }}<template v-if="data.course.code"> ({{ data.course.code }})</template> · </template>
        <template v-if="data.term">{{ termLabel(data.term) }} · </template>
        모집 인원 {{ data.capacity }}명
        <template v-if="data.closesAt"> · {{ formatDateTime(data.closesAt) }} 마감 예정</template>
        <template v-if="data.roomNameMode"> · 스터디 방 {{ NAME_MODE_LABELS[data.roomNameMode] }}</template>
      </p>
      <p v-if="data.description" class="prewrap">{{ data.description }}</p>

      <!-- 지원자 본인 -->
      <section v-if="data.myApplication" aria-labelledby="my-application" data-testid="my-application">
        <h2 id="my-application">내 지원</h2>
        <p data-testid="my-application-status">{{ data.myApplication.statusText }}</p>
        <p v-if="data.status === 'cancelled'" class="small">모집이 취소되었습니다.</p>
        <p v-if="data.myApplication.message" class="small prewrap">{{ data.myApplication.message }}</p>
        <p v-if="data.myApplication.invitationAvailable" class="actions">
          <button type="button" :disabled="busy === 'invite'" @click="getInvitation">{{ data.kind === 'team' ? '팀 과제 공간 초대 받기' : '스터디 방 초대 받기' }}</button>
        </p>
        <p v-if="invite" class="notice ok" role="status">
          초대가 준비되었습니다. 수락해야 {{ invite.kind === 'project' ? '팀원' : '멤버' }}이 됩니다.
          <NuxtLink :to="invitePath" data-testid="invite-link">초대 열기</NuxtLink>
        </p>
        <p v-if="data.status === 'open' && (data.myApplication.status === 'pending' || data.myApplication.status === 'accepted')" class="actions">
          <button type="button" class="secondary" :disabled="busy === 'withdraw'" @click="withdraw">지원 취소</button>
        </p>
      </section>

      <!-- 지원하기 -->
      <section v-else-if="data.canApply" aria-labelledby="apply">
        <h2 id="apply">지원하기</h2>
        <p class="hint">지원하면 모집자에게 내 계정 이름(표시명 페르소나 이름이 아닙니다)과 아래 내용이 보입니다. 다른 지원자·모더레이터·운영자에게는 보이지 않습니다.</p>
        <form class="stack" novalidate @submit.prevent="apply">
          <div class="field">
            <label for="apply-message">하고 싶은 말(선택)</label>
            <textarea id="apply-message" v-model="form.message" rows="4" :maxlength="APPLICATION_MESSAGE_MAX" aria-describedby="apply-message-hint" />
            <p id="apply-message-hint" class="hint">{{ form.message.length }}/{{ APPLICATION_MESSAGE_MAX }}자</p>
            <p v-if="fieldErrors.message" class="field-error">{{ fieldMessage(fieldErrors.message) }}</p>
          </div>
          <fieldset>
            <legend>첨부(선택)</legend>
            <div v-if="options?.profile" class="radio-row">
              <input id="attach-profile" v-model="form.attachProfile" type="checkbox" />
              <label for="attach-profile">내 공개 프로필(@{{ options.profile.handle }})</label>
            </div>
            <div v-for="(c, i) in options?.cases ?? []" :key="c.slug" class="radio-row">
              <input :id="`attach-case-${i}`" v-model="form.caseSlugs" type="checkbox" :value="c.slug" :disabled="!form.caseSlugs.includes(c.slug) && form.caseSlugs.length >= APPLICATION_CASES_MAX" />
              <label :for="`attach-case-${i}`">공개 사례: {{ c.title }}</label>
            </div>
            <p v-if="options && !options.profile && !options.cases.length" class="small muted">붙일 수 있는 공개 프로필·공개 사례가 없습니다. 첨부 없이 지원할 수 있습니다.</p>
            <p v-if="fieldErrors.attachProfile || Object.keys(fieldErrors).some((k) => k.startsWith('caseSlugs'))" class="field-error">
              지금 공개 중인 내 프로필·사례만 붙일 수 있습니다.
            </p>
          </fieldset>
          <p class="actions"><button type="submit" :disabled="busy === 'apply'">지원하기</button></p>
        </form>
      </section>
      <p v-else-if="!isRecruiter && data.applyBlockedReason" class="small muted" data-testid="apply-blocked">{{ communityErrorMessage(data.applyBlockedReason) }}</p>

      <!-- 모집자 -->
      <section v-if="data.recruiter" aria-labelledby="recruiter" data-testid="recruiter-dashboard">
        <h2 id="recruiter">지원자(나만 보임)</h2>
        <p class="small">
          지원 {{ data.recruiter.applicationCount }}명 · 검토 중 {{ data.recruiter.pendingCount }}명 · 선정 {{ data.recruiter.acceptedCount }}/{{ data.capacity }}명. 지원한 순서대로
          보이며 순위·활동량은 없습니다. 선정하지 않을 때 사유를 남기지 않습니다.
        </p>
        <ol v-if="applications.length" class="plain hub-list" data-testid="application-list">
          <li v-for="a in applications" :key="a.id" class="hub-card" data-testid="application-item">
            <p>
              <strong>{{ a.applicant.displayName }}</strong>
              <span class="badge" data-testid="application-item-status">{{ RECRUITER_STATUS_TEXT[a.status] }}</span>
            </p>
            <p class="small muted">{{ formatDateTime(a.createdAt) }} 지원</p>
            <p v-if="a.message" :class="['small', 'prewrap', { muted: a.messageHidden }]">{{ a.message }}</p>
            <p v-if="a.attachments.profile || a.attachments.cases.length" class="small">
              <NuxtLink v-if="a.attachments.profile" :to="`/u/${a.attachments.profile.handle}`">공개 프로필 @{{ a.attachments.profile.handle }}</NuxtLink>
              <template v-for="c in a.attachments.cases" :key="c.slug"> · <NuxtLink :to="`/p/${c.slug}`">{{ c.title }}</NuxtLink></template>
            </p>
            <p v-if="data.status === 'open'" class="actions">
              <button v-if="a.status === 'pending'" type="button" :disabled="busy === `accept-${a.id}`" @click="accept(a.id)">선정</button>
              <button v-if="a.status === 'pending' || a.status === 'accepted'" type="button" class="secondary" :disabled="busy === `decline-${a.id}`" @click="decline(a.id)">
                선정 안 함
              </button>
            </p>
            <ReportButton
              v-if="a.message && !a.messageHidden"
              :id-prefix="`report-application-${a.id}`"
              label="메시지 신고"
              :targets="[{ id: a.id, label: '이 지원 메시지', targetType: 'community_application', targetRef: { applicationId: a.id } }]"
            />
          </li>
        </ol>
        <p v-else class="muted">아직 지원자가 없습니다.</p>
        <p v-if="data.status === 'open'" class="actions">
          <button type="button" :disabled="busy === 'close' || data.recruiter.acceptedCount === 0" aria-describedby="close-hint" @click="close">마감하고 {{ data.kind === 'team' ? '과제 공간' : '스터디 방' }} 만들기</button>
          <button type="button" class="secondary" :disabled="busy === 'cancel'" @click="cancel">모집 취소</button>
        </p>
        <p v-if="data.status === 'open'" id="close-hint" class="hint">
          {{ data.kind === 'team' ? '마감하면 비공개 과제 공간이 만들어지고' : '마감하면 초대 전용 스터디 방이 만들어지고' }} 선정한 사람에게 초대 알림이 갑니다. 각자 초대를 수락해야 들어옵니다. 검토 중인
          지원은 선정되지 않음으로 닫힙니다.
        </p>
        <p v-if="resultLink"><NuxtLink :to="resultLink.to" data-testid="result-link">{{ resultLink.label }}</NuxtLink></p>
      </section>

      <ReportButton v-if="data.canReport" id-prefix="report-recruitment" label="모집 글 신고" :targets="reportTargets" />
      <p><NuxtLink to="/community/recruitments">내 모집·내 지원</NuxtLink></p>
    </template>
  </div>
</template>
