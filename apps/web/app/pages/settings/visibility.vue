<script setup lang="ts">
/**
 * 공개 범위·과제 수행 목록(S-03, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1·§8.3, DELIVERY_PLAN §5.2 S, ADR 0031).
 * - 페르소나(실명·표시명)마다 네 항목(과제 수행 목록·공개 글·선배 노트·스터디 기록·팔로워·팔로잉 목록)의 공개 범위를 고릅니다. 팔로우 목록은
 *   전체 공개·비공개 두 가지만입니다. 저장하지 않은 항목은 기본값(과제 수행 목록 비공개, 나머지는 로그인 사용자)을 씁니다.
 * - 공개 사례·케이스 스터디는 여기서 바꿀 수 없습니다(공개 절차로만). 비공개 계정은 더 넓게 골라도 승인한 팔로워까지만 적용됩니다.
 * - 표시명 프로필에 `같은 기관`을 고르면 열람 성공 여부로 소속이 추정될 수 있다고 안내합니다.
 * - 과제 수행 목록은 실명 프로필에만 둡니다. 내가 멤버인 과제 중 직접 고른 것만, 과목·학기·제목만 보이고 엠바고 중에는 제목이 빠집니다.
 *   익명·표시명 스터디 방의 기록은 고를 수 없습니다. 목록에 올려도 과제 공간을 볼 수 있는 사람은 바뀌지 않습니다.
 */
import {
  VISIBILITY_AUDIENCE_LABELS,
  VISIBILITY_ITEM_LABELS,
  type VisibilityAudience,
  type VisibilityItemKind,
} from '@peerchive/domain'
import type { MyPersonasDto, MyProjectListingDto, MyProjectListingsDto, PersonaVisibilityDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '공개 범위 — Peerchive' })

const requestFetch = useRequestFetch()
const { data: mine } = await useAsyncData('visibility-personas', () => requestFetch<MyPersonasDto>('/api/v1/me/personas'))
const personas = computed(() => (mine.value?.personas ?? []).filter((p) => p.kind === 'display' || p.profile))
const route = useRoute()
const selectedId = ref<string>(
  personas.value.find((p) => p.id === route.query.persona)?.id ?? personas.value.find((p) => p.kind === 'real')?.id ?? personas.value[0]?.id ?? '',
)
const selected = computed(() => personas.value.find((p) => p.id === selectedId.value) ?? null)

const { data: visibility, refresh: refreshVisibility } = await useAsyncData(
  () => `visibility:${selectedId.value}`,
  () => (selectedId.value ? requestFetch<PersonaVisibilityDto>(`/api/v1/personas/${selectedId.value}/visibility`) : Promise.resolve(null)),
  { watch: [selectedId] },
)
const { data: listings, refresh: refreshListings } = await useAsyncData(
  () => `project-listings:${selectedId.value}`,
  () =>
    selected.value?.kind === 'real' ? requestFetch<MyProjectListingsDto>(`/api/v1/personas/${selectedId.value}/project-listings`) : Promise.resolve(null),
  { watch: [selectedId] },
)

const form = reactive<Record<VisibilityItemKind, VisibilityAudience>>({
  project_list: 'private',
  posts: 'signed_in',
  notes_and_studies: 'signed_in',
  follow_lists: 'private',
})
watch(
  visibility,
  (v) => {
    for (const item of v?.items ?? []) form[item.itemKind] = item.audience
  },
  { immediate: true },
)

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)

const ITEM_HINTS: Record<VisibilityItemKind, string> = {
  project_list: '과목·학기·과제 제목만 보입니다. 팀원 이름·로그·파일은 보이지 않고, 엠바고 중인 과제는 제목 없이 과목·학기만 보입니다.',
  posts: '실명·표시명으로 쓴 글만 해당합니다. 익명으로 쓴 글은 어떤 설정에서도 프로필에 나오지 않습니다.',
  notes_and_studies: '익명으로 쓴 선배 노트와 익명 스터디 기록은 어떤 설정에서도 나오지 않습니다.',
  follow_lists: '팔로워·팔로잉 목록에는 프로필 이름과 handle만 보입니다. 전체 공개 또는 비공개만 고를 수 있습니다.',
}

const sameInstitutionOnDisplay = computed(
  () => selected.value?.kind === 'display' && Object.values(form).includes('same_institution'),
)
const changed = computed(() => (visibility.value?.items ?? []).filter((i) => form[i.itemKind] !== i.audience))

async function save() {
  if (!selected.value || changed.value.length === 0) return
  busy.value = 'save'
  notice.value = null
  errors.value = {}
  try {
    const items = Object.fromEntries(changed.value.map((i) => [i.itemKind, form[i.itemKind]]))
    visibility.value = await $fetch<PersonaVisibilityDto>(`/api/v1/personas/${selected.value.id}/visibility`, { method: 'PUT', body: { items } })
    if (selected.value.kind === 'real') await refreshListings()
    notice.value = { kind: 'ok', text: '공개 범위를 저장했습니다. 다음 요청부터 적용됩니다.' }
  } catch (error) {
    const e = apiError(error)
    if (e.status === 422) {
      errors.value = e.fields
      notice.value = { kind: 'error', text: '고를 수 없는 값이 있습니다. 항목을 확인하세요.' }
    } else {
      notice.value = { kind: 'error', text: '저장하지 못했습니다. 다시 시도하세요.' }
      await refreshVisibility()
    }
  } finally {
    busy.value = null
  }
}

async function toggleListing(p: MyProjectListingDto) {
  if (!selected.value) return
  busy.value = p.projectId
  notice.value = null
  try {
    listings.value = await $fetch<MyProjectListingsDto>(`/api/v1/personas/${selected.value.id}/project-listings`, {
      method: 'PUT',
      body: { projectId: p.projectId, shown: !p.listed },
    })
    notice.value = { kind: 'ok', text: p.listed ? `"${p.title}"을(를) 목록에서 내렸습니다.` : `"${p.title}"을(를) 목록에 올렸습니다.` }
  } catch (error) {
    const e = apiError(error)
    const text =
      e.code === 'anonymous_study' || e.code === 'display_study'
        ? '익명·표시명 스터디 방의 기록은 실명 프로필에 올릴 수 없습니다.'
        : e.status === 404
          ? '지금 멤버인 과제만 올릴 수 있습니다.'
          : '바꾸지 못했습니다. 다시 시도하세요.'
    notice.value = { kind: 'error', text }
    await refreshListings()
  } finally {
    busy.value = null
  }
}

const itemError = (kind: VisibilityItemKind) => {
  const code = errors.value[`items.${kind}`]
  return code === 'real_persona_only' ? '과제 수행 목록은 실명 프로필에만 둘 수 있습니다.' : fieldMessage(code)
}
const audienceLabel = (a: VisibilityAudience | undefined) => (a ? VISIBILITY_AUDIENCE_LABELS[a] : '')
</script>

<template>
  <div>
    <h1>공개 범위</h1>
    <p class="hint">
      공개 프로필에서 항목마다 누가 볼 수 있는지 고릅니다. <strong>공개 사례·케이스 스터디는 여기서 바뀌지 않습니다</strong> — 팀 동의와 게시를 거친
      것만 프로필에 나오고, 이 설정으로 더 넓힐 수 없습니다. 어떤 설정이든 과제 공간을 볼 수 있는 사람은 바뀌지 않습니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <p v-if="!personas.length" class="notice error">먼저 <NuxtLink to="/onboarding">실명 프로필</NuxtLink>을 만드세요.</p>
    <template v-else>
      <fieldset v-if="personas.length > 1" class="stack">
        <legend>프로필</legend>
        <label v-for="p in personas" :key="p.id" class="check">
          <input v-model="selectedId" type="radio" name="persona" :value="p.id" />
          {{ p.kind === 'real' ? '실명 프로필' : '표시명 프로필' }} — {{ p.displayName }} @{{ p.handle }}
        </label>
      </fieldset>

      <section v-if="visibility && selected" aria-labelledby="items-heading">
        <h2 id="items-heading">{{ selected.kind === 'real' ? '실명 프로필' : '표시명 프로필' }}의 항목별 공개 범위</h2>
        <p v-if="visibility.accountPrivacy === 'private'" class="hint">
          비공개 계정입니다. 더 넓게 골라도 <strong>승인한 팔로워</strong>까지만 보입니다(<NuxtLink to="/settings/follows">팔로우·차단</NuxtLink>에서 요청을 승인).
        </p>
        <form class="stack" novalidate @submit.prevent="save">
          <div v-for="item in visibility.items" :key="item.itemKind" class="field">
            <label :for="`audience-${item.itemKind}`">{{ VISIBILITY_ITEM_LABELS[item.itemKind] }}</label>
            <select
              :id="`audience-${item.itemKind}`"
              v-model="form[item.itemKind]"
              :disabled="item.allowed.length < 2"
              :aria-invalid="errors[`items.${item.itemKind}`] ? 'true' : undefined"
              :aria-describedby="`audience-${item.itemKind}-hint`"
            >
              <option v-for="a in item.allowed" :key="a" :value="a">{{ VISIBILITY_AUDIENCE_LABELS[a] }}</option>
            </select>
            <p :id="`audience-${item.itemKind}-hint`" class="hint">
              <template v-if="item.itemKind === 'project_list' && selected.kind === 'display'">
                과제 수행 목록은 실명 프로필에만 둘 수 있습니다. 표시명 프로필에 팀 과제를 올리면 팀원이 두 프로필을 같은 사람으로 알아볼 수 있습니다.
              </template>
              <template v-else>{{ ITEM_HINTS[item.itemKind] }}</template>
              <template v-if="item.isDefault"> (기본값)</template>
              <template v-if="item.effective !== item.audience"> 지금 적용: {{ audienceLabel(item.effective) }}.</template>
            </p>
            <p v-if="itemError(item.itemKind)" class="field-error">{{ itemError(item.itemKind) }}</p>
          </div>
          <p v-if="sameInstitutionOnDisplay" class="notice error" role="note">
            표시명 프로필에 <strong>같은 기관</strong>을 고르면, 그 항목이 보이는지 여부로 다른 사람이 내 학교를 짐작할 수 있습니다.
            소속을 드러내고 싶지 않다면 다른 범위를 고르세요.
          </p>
          <p class="hint">
            "같은 기관"은 학교 메일 인증을 한 사람 중 나와 같은 학교 인증이 있는 사람입니다. "승인한 팔로워"는 이 프로필을 팔로우하고(비공개 계정이면 내가 승인한) 사람입니다.
          </p>
          <p class="actions">
            <button type="submit" :disabled="busy === 'save' || changed.length === 0">저장</button>
          </p>
        </form>
      </section>

      <section v-if="selected?.kind === 'real' && listings" aria-labelledby="listing-heading">
        <h2 id="listing-heading">과제 수행 목록</h2>
        <p class="hint">
          고른 과제만 실명 프로필에 <strong>과목 · 학기 · 과제 제목</strong>으로 보입니다(지금 공개 범위: {{ audienceLabel(listings.audience) }}).
          팀원 이름·로그·파일은 보이지 않고, 목록에 올려도 과제 공간을 볼 수 있는 사람은 바뀌지 않습니다.
        </p>
        <p v-if="!listings.projects.length" class="muted">지금 멤버인 과제가 없습니다.</p>
        <ul v-else class="plain stack">
          <li v-for="p in listings.projects" :key="p.projectId">
            <label class="check">
              <input type="checkbox" :checked="p.listed" :disabled="!!p.block || busy === p.projectId" @change="toggleListing(p)" />
              <span>
                <template v-if="p.courseTitle">{{ p.courseTitle }} · </template><template v-if="p.termLabel">{{ p.termLabel }} · </template>{{ p.title }}
              </span>
            </label>
            <p v-if="p.block" class="hint">익명·표시명 스터디 방의 기록이라 실명 프로필에 올릴 수 없습니다.</p>
            <p v-else-if="p.embargoActive" class="hint">엠바고 중이라 공개 프로필에는 제목 없이 과목·학기만 보입니다.</p>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
