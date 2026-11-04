<script setup lang="ts">
/**
 * 모집 게시판(C-07, ADR 0024). `?space=<slug>`(공식 페이지·방의 모집 게시판) 또는 `?course=<id>`(그 과목 학교 인증 사용자만)의 모집 카드와
 * 모집 글 쓰기. 맥락이 없으면 "내 모집·내 지원". 로그인 전용·noindex·제목 고정(C-05).
 * - 카드에는 종류(팀원/스터디)·과목·모집 인원·상태만 있고 지원자 수는 없습니다(모집자는 상세에서 봄).
 */
import type { MyRecruitmentsDto, NameMode, RecruitmentDetailDto, RecruitmentKind, RecruitmentListDto, RecruitmentSummaryDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const spaceSlug = computed(() => (typeof route.query.space === 'string' ? route.query.space : ''))
const courseId = computed(() => (typeof route.query.course === 'string' ? route.query.course : ''))
const hasContext = computed(() => !!spaceSlug.value || !!courseId.value)
const fetcher = useRequestFetch()

const { data, error, refresh } = await useAsyncData(
  () => `recruitments-${spaceSlug.value}-${courseId.value}`,
  () =>
    hasContext.value
      ? fetcher<RecruitmentListDto>('/api/v1/community/recruitments', { query: spaceSlug.value ? { space: spaceSlug.value } : { course: courseId.value } })
      : Promise.resolve(null),
  { watch: [spaceSlug, courseId] },
)
const { data: mine } = await useAsyncData(
  () => `recruitments-mine-${hasContext.value}`,
  () => (hasContext.value ? Promise.resolve(null) : fetcher<MyRecruitmentsDto>('/api/v1/community/recruitments/mine')),
  { watch: [hasContext] },
)
const missing = computed(() => hasContext.value && (!!error.value || !data.value))
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const form = reactive({
  kind: 'study' as RecruitmentKind,
  title: '',
  description: '',
  capacity: 3,
  termId: '',
  closesAt: '',
  roomNameMode: 'display' as NameMode,
})
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const fieldErrors = ref<Record<string, string>>({})
const FIELD_TEXT: Record<string, string> = {
  required: '입력하세요.',
  too_long: '너무 깁니다.',
  too_small: `${RECRUITMENT_CAPACITY_MIN}명 이상이어야 합니다.`,
  too_large: `${RECRUITMENT_CAPACITY_MAX}명까지입니다.`,
  invalid: '값이 올바르지 않습니다.',
  reserved: '스터디 방 이름이 되므로 `공식`·`운영자` 같은 말은 쓸 수 없습니다.',
  past: '지금 이후로 정하세요.',
  too_far: '90일 안으로 정하세요.',
  not_in_course: '이 과목의 학기를 고르세요.',
}

const canPostAny = computed(() => !!data.value && (data.value.canPost.team || data.value.canPost.study))
watch(
  data,
  (d) => {
    if (d && !d.canPost[form.kind]) form.kind = d.canPost.study ? 'study' : 'team'
  },
  { immediate: true },
)

function blockedText(reason: string | null | undefined): string {
  return reason ? communityErrorMessage(reason) : ''
}

async function submit() {
  if (!data.value) return
  busy.value = true
  notice.value = null
  fieldErrors.value = {}
  try {
    const body: Record<string, unknown> = {
      kind: form.kind,
      title: form.title,
      description: form.description,
      capacity: Number(form.capacity),
      ...(spaceSlug.value && { spaceSlug: spaceSlug.value }),
      ...(courseId.value && { courseId: data.value.context.course?.id ?? courseId.value }),
      ...(form.termId && { termId: form.termId }),
      ...(form.closesAt && { closesAt: new Date(form.closesAt).toISOString() }),
      ...(form.kind === 'study' && { roomNameMode: form.roomNameMode }),
    }
    const created = await $fetch<RecruitmentDetailDto>('/api/v1/community/recruitments', { method: 'POST', body })
    await navigateTo(`/community/recruitments/${created.id}`)
  } catch (e) {
    const err = apiError(e)
    fieldErrors.value = err.fields
    notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
    if (err.code !== 'validation_failed') await refresh()
  } finally {
    busy.value = false
  }
}

function cardMeta(r: RecruitmentSummaryDto): string {
  const parts: string[] = []
  if (r.course) parts.push(`${r.course.title}${r.course.code ? ` (${r.course.code})` : ''}`)
  if (r.term) parts.push(termLabel(r.term))
  parts.push(`모집 인원 ${r.capacity}명`)
  if (r.closesAt && r.status === 'open') parts.push(`${formatDateTime(r.closesAt)} 마감 예정`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="community-page recruitments-page">
    <template v-if="!hasContext">
      <h1>모집·내 지원</h1>
      <p class="hint">팀원 찾기·스터디 모집은 공식 페이지·방의 모집 게시판이나 과목 화면에서 올립니다. 지원자 목록은 모집자만 봅니다.</p>
      <section aria-labelledby="my-created">
        <h2 id="my-created">내가 올린 모집</h2>
        <ul v-if="mine?.created.length" class="plain hub-list" data-testid="my-recruitments">
          <li v-for="r in mine.created" :key="r.id" class="hub-card">
            <p>
              <span class="badge">{{ RECRUITMENT_KIND_LABELS[r.kind] }}</span>
              <NuxtLink :to="`/community/recruitments/${r.id}`"><strong>{{ r.title }}</strong></NuxtLink>
            </p>
            <p class="small muted">{{ RECRUITMENT_STATUS_LABELS[r.status] }} · {{ cardMeta(r) }}</p>
          </li>
        </ul>
        <p v-else class="muted">올린 모집이 없습니다.</p>
      </section>
      <section aria-labelledby="my-applications">
        <h2 id="my-applications">내 지원</h2>
        <ul v-if="mine?.applications.length" class="plain hub-list" data-testid="my-applications">
          <li v-for="a in mine.applications" :key="a.id" class="hub-card">
            <p>
              <template v-if="a.recruitment">
                <span class="badge">{{ RECRUITMENT_KIND_LABELS[a.recruitment.kind] }}</span>
                <NuxtLink :to="`/community/recruitments/${a.recruitment.id}`"><strong>{{ a.recruitment.title }}</strong></NuxtLink>
              </template>
              <span v-else class="muted">지금은 볼 수 없는 모집</span>
            </p>
            <p class="small">
              <span data-testid="application-status">{{ a.statusText }}</span>
              <template v-if="a.invitationAvailable"> · 초대를 받을 수 있습니다</template>
            </p>
          </li>
        </ul>
        <p v-else class="muted">지원한 모집이 없습니다.</p>
      </section>
    </template>

    <template v-else-if="missing">
      <h1>모집 게시판을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 모집을 볼 수 있는 학교 인증·멤버십이 없습니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>

    <template v-else-if="data">
      <p class="small">
        <NuxtLink v-if="data.context.space" :to="`/community/s/${data.context.space.slug}`">{{ data.context.space.name }}</NuxtLink>
        <template v-if="data.context.course">{{ data.context.course.schoolName }} · {{ data.context.course.title }}</template>
      </p>
      <h1>모집</h1>
      <p class="hint">
        팀원 찾기와 스터디 모집을 한 목록에서 봅니다. 지원자 목록은 모집자만 보고, 지원자를 활동량·순위로 정렬하지 않으며, 거절 사유를 남기지 않습니다.
      </p>
      <p v-if="data.registrationRequired" class="notice" role="status" data-testid="recruitment-registration-required">
        과목을 등록하면 볼 수 있습니다. <NuxtLink to="/me/courses">내 과목에서 등록하기</NuxtLink>
      </p>
      <p v-if="data.teamFindingDisabled" class="notice" role="status">이 과목은 수업에서 팀을 배정해 팀원 찾기를 쓰지 않습니다. 스터디 모집은 올릴 수 있습니다.</p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <section v-if="!data.registrationRequired || data.items.length" aria-labelledby="recruitment-list">
        <h2 id="recruitment-list">모집 글</h2>
        <ul v-if="data.items.length" class="plain hub-list" data-testid="recruitment-list">
          <li v-for="r in data.items" :key="r.id" class="hub-card" data-testid="recruitment-card">
            <p>
              <span class="badge" data-testid="recruitment-kind">{{ RECRUITMENT_KIND_LABELS[r.kind] }}</span>
              <span class="badge">{{ RECRUITMENT_STATUS_LABELS[r.status] }}</span>
              <span v-if="r.mine" class="badge">내 모집</span>
            </p>
            <p>
              <NuxtLink :to="`/community/recruitments/${r.id}`"><strong>{{ r.title }}</strong></NuxtLink>
            </p>
            <p class="small muted">{{ cardMeta(r) }}</p>
            <p v-if="r.myApplicationStatus" class="small">내 지원: {{ APPLICATION_STATUS_TEXT[r.myApplicationStatus] }}</p>
          </li>
        </ul>
        <p v-else class="muted">아직 모집 글이 없습니다.</p>
      </section>

      <section v-if="canPostAny" aria-labelledby="new-recruitment">
        <h2 id="new-recruitment">모집 글 쓰기</h2>
        <form class="stack" novalidate @submit.prevent="submit">
          <fieldset>
            <legend>종류</legend>
            <div v-if="data.canPost.team" class="radio-row">
              <input id="kind-team" v-model="form.kind" type="radio" name="recruitment-kind" value="team" />
              <label for="kind-team">팀원 찾기(과제 공간과 초대로 이어짐)</label>
            </div>
            <div v-if="data.canPost.study" class="radio-row">
              <input id="kind-study" v-model="form.kind" type="radio" name="recruitment-kind" value="study" />
              <label for="kind-study">스터디 모집(스터디 방과 초대로 이어짐)</label>
            </div>
          </fieldset>
          <p v-if="!data.canPost.team && data.postBlockedReasons.team" class="small muted">팀원 찾기: {{ blockedText(data.postBlockedReasons.team) }}</p>
          <div class="field">
            <label for="rec-title">제목</label>
            <input id="rec-title" v-model="form.title" :maxlength="RECRUITMENT_TITLE_MAX" required aria-describedby="rec-title-hint rec-title-error" />
            <p id="rec-title-hint" class="hint">{{ form.kind === 'study' ? '마감하면 이 제목(앞 40자)으로 스터디 방이 만들어집니다.' : '마감하면 과목 이름으로 비공개 과제 공간이 만들어집니다.' }}</p>
            <p v-if="fieldErrors.title" id="rec-title-error" class="field-error">{{ FIELD_TEXT[fieldErrors.title] ?? fieldMessage(fieldErrors.title) }}</p>
          </div>
          <div class="field">
            <label for="rec-description">소개(주제·기간·진행 방식·목표, 선택)</label>
            <textarea id="rec-description" v-model="form.description" rows="5" :maxlength="RECRUITMENT_DESCRIPTION_MAX" aria-describedby="rec-description-hint" />
            <p id="rec-description-hint" class="hint">{{ form.description.length }}/{{ RECRUITMENT_DESCRIPTION_MAX }}자</p>
            <p v-if="fieldErrors.description" class="field-error">{{ FIELD_TEXT[fieldErrors.description] ?? fieldMessage(fieldErrors.description) }}</p>
          </div>
          <div class="field">
            <label for="rec-capacity">모집 인원(나를 빼고 {{ RECRUITMENT_CAPACITY_MIN }}~{{ RECRUITMENT_CAPACITY_MAX }}명)</label>
            <input id="rec-capacity" v-model.number="form.capacity" type="number" :min="RECRUITMENT_CAPACITY_MIN" :max="RECRUITMENT_CAPACITY_MAX" required />
            <p v-if="fieldErrors.capacity" class="field-error">{{ FIELD_TEXT[fieldErrors.capacity] ?? fieldMessage(fieldErrors.capacity) }}</p>
          </div>
          <div v-if="data.terms.length" class="field">
            <label for="rec-term">학기(선택)</label>
            <select id="rec-term" v-model="form.termId" aria-describedby="rec-term-hint">
              <option value="">고르지 않음</option>
              <option v-for="t in data.terms" :key="t.id" :value="t.id">{{ termLabel(t) }}</option>
            </select>
            <p id="rec-term-hint" class="hint">팀원 찾기를 마감하면 과제 공간에 이 학기가 연결되고 학기가 끝날 때까지 공개가 막힙니다(엠바고).</p>
            <p v-if="fieldErrors.termId" class="field-error">{{ FIELD_TEXT[fieldErrors.termId] ?? fieldMessage(fieldErrors.termId) }}</p>
          </div>
          <div class="field">
            <label for="rec-closes">마감 예정 시각(선택)</label>
            <input id="rec-closes" v-model="form.closesAt" type="datetime-local" />
            <p v-if="fieldErrors.closesAt" class="field-error">{{ FIELD_TEXT[fieldErrors.closesAt] ?? fieldMessage(fieldErrors.closesAt) }}</p>
          </div>
          <fieldset v-if="form.kind === 'study'">
            <legend>스터디 방 이름 표시 방식</legend>
            <div v-for="mode in (['display', 'real', 'anonymous'] as const)" :key="mode" class="radio-row">
              <input :id="`room-mode-${mode}`" v-model="form.roomNameMode" type="radio" name="room-name-mode" :value="mode" />
              <label :for="`room-mode-${mode}`">{{ NAME_MODE_LABELS[mode] }}{{ mode === 'display' ? '(기본)' : '' }}</label>
            </div>
            <p class="hint">서로 책임을 지는 모임이라 표시명이 기본입니다. 익명 스터디 방의 기록은 포트폴리오에 연결할 수 없습니다.</p>
          </fieldset>
          <p class="actions"><button type="submit" :disabled="busy">모집 올리기</button></p>
        </form>
      </section>
      <p v-else-if="!data.registrationRequired" class="small muted" data-testid="post-blocked">모집 글 쓰기: {{ blockedText(data.postBlockedReasons.study ?? data.postBlockedReasons.team) }}</p>
      <p><NuxtLink to="/community/recruitments">내 모집·내 지원 보기</NuxtLink></p>
    </template>
    <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
  </div>
</template>
