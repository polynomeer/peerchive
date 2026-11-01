<script setup lang="ts">
/**
 * 동문회·OB 방의 방별 프로필 화면(A-01, PROOFU_EVOLUTION_PLAN §8.9.9, ADR 0038). 로그인 전용·noindex, 방 멤버에게만.
 * - 내 방별 프로필: 실명 방은 이름이 실명으로 고정(배지·기수·소개만), 표시명 방은 이 방에서만 쓰는 이름. 지우기.
 * - 멤버 목록: 이름·배지·기수·소개. 방장·운영진은 멤버의 기수를 고칠 수 있고, 고친 이력은 방장·운영진과 본인만 봅니다.
 * - P2 alumni 플래그가 꺼져 있거나 멤버가 아니면 "찾을 수 없습니다"(서버 404). 익명 방은 방별 프로필이 없습니다.
 * 방 밖(공개 프로필·검색·피드·활동)에는 이 화면의 값이 나가지 않습니다.
 * - A-07(ADR 0045): 다른 멤버의 프로필마다 "신고"(사유에 소속·기수 사칭 포함). 운영 조치로 숨긴 내 프로필은 "운영 조치로 숨김"으로 보이고
 *   다른 멤버에게는 프로필이 없는 것처럼(`방별 이름 없음`) 보입니다.
 */
import type { RoomProfileCohortChangeDto, RoomProfileDto, RoomProfilesDto, RoomStoredBadge, SpaceDetailDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const fetcher = useRequestFetch()
const { data: space } = await useAsyncData(`room-profiles-space-${slug.value}`, () => fetcher<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}`).catch(() => null))
const { data: state, error } = await useAsyncData(`room-profiles-${slug.value}`, () => fetcher<RoomProfilesDto>(`/api/v1/community/spaces/${slug.value}/room-profiles`))
const unavailable = computed(() => apiError(error.value).code === 'room_profiles_unavailable')
const missing = computed(() => !state.value && !unavailable.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
const fieldErrors = ref<Record<string, string>>({})

const FIELD_TEXT: Record<string, string> = {
  required: '이 방에서 쓸 이름을 적으세요.',
  name_fixed: '실명 방에서는 이름이 실명으로 고정됩니다.',
  too_long: '너무 깁니다.',
  invalid: '쓸 수 없는 값입니다.',
  conflict: '현역과 OB는 함께 고를 수 없습니다.',
}

const form = reactive({ displayName: '', badges: [] as RoomStoredBadge[], cohortLabel: '', bio: '' })
function fillForm(s: RoomProfilesDto | null | undefined) {
  form.displayName = s?.mine?.displayName ?? ''
  form.badges = [...(s?.mine?.storedBadges ?? [])]
  form.cohortLabel = s?.mine?.cohortLabel ?? ''
  form.bio = s?.mine?.bio ?? ''
}
watch(state, fillForm, { immediate: true })

function toggleBadge(b: RoomStoredBadge, on: boolean) {
  const next = new Set(form.badges)
  if (on) {
    next.add(b)
    // 현역·OB는 함께 고를 수 없습니다.
    if (b === 'current') next.delete('ob')
    if (b === 'ob') next.delete('current')
  } else next.delete(b)
  form.badges = (['current', 'ob', 'alumni'] as const).filter((x) => next.has(x))
}

function fail(e: unknown) {
  const err = apiError(e)
  fieldErrors.value = err.fields
  notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
}

async function save() {
  busy.value = 'save'
  notice.value = null
  fieldErrors.value = {}
  try {
    state.value = await $fetch<RoomProfilesDto>(`/api/v1/community/spaces/${slug.value}/room-profile`, {
      method: 'PUT',
      body: {
        ...(state.value?.nameMode === 'display' && { displayName: form.displayName }),
        badges: form.badges,
        cohortLabel: form.cohortLabel.trim() || null,
        bio: form.bio.trim() || null,
      },
    })
    notice.value = { kind: 'ok', text: '방별 프로필을 저장했습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

async function remove() {
  if (!confirm('이 방의 내 프로필과 기수 이력을 지울까요?')) return
  busy.value = 'remove'
  notice.value = null
  try {
    state.value = await $fetch<RoomProfilesDto>(`/api/v1/community/spaces/${slug.value}/room-profile`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: '방별 프로필을 지웠습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

// ── 기수 고치기(방장·운영진)·이력 ──
const cohortDraft = reactive<Record<string, string>>({})
async function saveCohort(p: RoomProfileDto) {
  busy.value = `cohort-${p.id}`
  notice.value = null
  try {
    const value = (cohortDraft[p.id] ?? p.cohortLabel ?? '').trim()
    await $fetch<RoomProfileDto>(`/api/v1/community/spaces/${slug.value}/room-profiles/${p.id}/cohort`, { method: 'PUT', body: { cohortLabel: value || null } })
    state.value = await $fetch<RoomProfilesDto>(`/api/v1/community/spaces/${slug.value}/room-profiles`)
    delete history[p.id]
    notice.value = { kind: 'ok', text: `${p.name}의 기수를 고쳤습니다. 이력에 남습니다.` }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
const history = reactive<Record<string, RoomProfileCohortChangeDto[]>>({})
async function loadHistory(p: RoomProfileDto) {
  try {
    history[p.id] = await $fetch<RoomProfileCohortChangeDto[]>(`/api/v1/community/spaces/${slug.value}/room-profiles/${p.id}/cohort-history`)
  } catch (e) {
    fail(e)
  }
}
const CHANGED_BY_TEXT: Record<RoomProfileCohortChangeDto['changedBy'], string> = { subject: '본인', manager: '방장·운영진', unknown: '알 수 없음' }
</script>

<template>
  <div class="community-page">
    <template v-if="missing">
      <h1>찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 방의 멤버가 아닙니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else>
      <p class="small"><NuxtLink :to="`/community/s/${slug}`">← {{ space?.name ?? '방으로' }}</NuxtLink></p>
      <h1>방별 프로필</h1>
      <p class="hint">
        이 방 멤버에게만 보입니다. 공개 프로필·검색·피드·활동에는 나오지 않습니다. 현역·OB·졸업생 배지와 기수는 스스로 정하며 Peerchive가 확인하지 않습니다.
        기수는 방장·운영진도 고칠 수 있고, 고친 이력은 방장·운영진과 본인에게 보입니다. 방을 나가면 이 방의 프로필은 지워집니다.
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <p v-if="unavailable" class="notice">익명 방에는 방별 프로필이 없습니다.</p>

      <template v-if="state">
        <section aria-labelledby="my-room-profile">
          <h2 id="my-room-profile">내 프로필</h2>
          <form v-if="state.writable" class="stack" novalidate @submit.prevent="save">
            <div v-if="state.nameMode === 'display'" class="field">
              <label for="rp-name">이 방에서 쓸 이름 (필수)</label>
              <input id="rp-name" v-model="form.displayName" :maxlength="ROOM_PROFILE_NAME_MAX" aria-describedby="rp-name-hint" />
              <p id="rp-name-hint" class="hint">예: “12기 김지민”. 이 방의 표시명 글·댓글에 이 이름이 보입니다.</p>
              <p v-if="fieldErrors.displayName" class="field-error">{{ FIELD_TEXT[fieldErrors.displayName] ?? fieldMessage(fieldErrors.displayName) }}</p>
            </div>
            <p v-else class="hint">실명 방이라 이름은 실명으로 고정됩니다. 사진·배지·기수·소개만 방별로 정합니다.</p>
            <fieldset>
              <legend>신분 배지</legend>
              <label v-for="b in (['current', 'ob', 'alumni'] as const)" :key="b">
                <input type="checkbox" :checked="form.badges.includes(b)" @change="toggleBadge(b, ($event.target as HTMLInputElement).checked)" />
                {{ ROOM_BADGE_LABELS[b] }}
              </label>
              <p class="hint">현역과 OB는 함께 고를 수 없습니다. 학교를 연결한 방에서는 그 학교 졸업생 인증이 있으면 ‘졸업생 인증’으로 보입니다.</p>
              <p v-if="fieldErrors.badges" class="field-error">{{ FIELD_TEXT[fieldErrors.badges] ?? fieldMessage(fieldErrors.badges) }}</p>
            </fieldset>
            <div class="field">
              <label for="rp-cohort">기수 (선택)</label>
              <input id="rp-cohort" v-model="form.cohortLabel" :maxlength="ROOM_COHORT_LABEL_MAX" placeholder="예: 12기" />
              <p v-if="fieldErrors.cohortLabel" class="field-error">{{ FIELD_TEXT[fieldErrors.cohortLabel] ?? fieldMessage(fieldErrors.cohortLabel) }}</p>
            </div>
            <div class="field">
              <label for="rp-bio">소개 (선택)</label>
              <textarea id="rp-bio" v-model="form.bio" rows="3" :maxlength="ROOM_PROFILE_BIO_MAX" />
              <p v-if="fieldErrors.bio" class="field-error">{{ FIELD_TEXT[fieldErrors.bio] ?? fieldMessage(fieldErrors.bio) }}</p>
            </div>
            <p class="actions">
              <button type="submit" :disabled="busy === 'save'">저장</button>
              <button v-if="state.mine" type="button" class="secondary" :disabled="busy === 'remove'" @click="remove">내 프로필 지우기</button>
            </p>
          </form>
          <p v-else class="muted">보관되었거나 제한된 방이라 바꿀 수 없습니다.</p>
        </section>

        <section aria-labelledby="room-profile-list">
          <h2 id="room-profile-list">멤버 프로필</h2>
          <ul v-if="state.profiles.length" class="plain hub-list" data-testid="room-profile-list">
            <li v-for="p in state.profiles" :key="p.id" class="hub-card">
              <p>
                <strong>{{ p.name }}</strong>
                <RoomBadges :tag="p" />
                <span v-if="p.mine" class="badge">나</span>
                <span v-if="p.hidden" class="badge" data-testid="room-profile-hidden">운영 조치로 숨김(다른 멤버에게 보이지 않음)</span>
              </p>
              <p v-if="p.bio" class="small pre">{{ p.bio }}</p>
              <p v-if="!p.mine" class="small">
                <ReportButton
                  :id-prefix="`rp-${p.id}`"
                  label="신고"
                  :targets="[{ id: p.id, label: `방별 프로필 · ${p.name}`, targetType: 'room_item', targetRef: { spaceSlug: slug, kind: 'room_profile', itemId: p.id } }]"
                />
              </p>
              <form v-if="state.canEditCohort" class="row" novalidate @submit.prevent="saveCohort(p)">
                <label :for="`cohort-${p.id}`" class="small">기수 고치기</label>
                <input :id="`cohort-${p.id}`" v-model="cohortDraft[p.id]" :placeholder="p.cohortLabel ?? '없음'" :maxlength="ROOM_COHORT_LABEL_MAX" />
                <button type="submit" class="secondary" :disabled="busy === `cohort-${p.id}`">저장</button>
              </form>
              <p v-if="state.canEditCohort || p.mine" class="small">
                <button type="button" class="link" @click="loadHistory(p)">기수 변경 이력</button>
              </p>
              <ul v-if="history[p.id]" class="plain small">
                <li v-if="!history[p.id]!.length" class="muted">이력이 없습니다.</li>
                <li v-for="h in history[p.id]" :key="h.id">
                  {{ formatDateTime(h.createdAt) }} · {{ h.fromLabel ?? '없음' }} → {{ h.toLabel ?? '없음' }} ·
                  {{ CHANGED_BY_TEXT[h.changedBy] }}<template v-if="h.changedByName"> ({{ h.changedByName }})</template>
                </li>
              </ul>
            </li>
          </ul>
          <p v-else class="muted">아직 방별 프로필을 만든 멤버가 없습니다.</p>
        </section>
      </template>
    </template>
  </div>
</template>
