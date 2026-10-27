<script setup lang="ts">
/**
 * 공개 프로필의 팔로우·차단·뮤트(S-04, SYSTEM_DESIGN §6.7.1·§8.3, DELIVERY_PLAN §5.2 T·U, ADR 0033).
 * - 공개 화면 SSR은 로그인 상태를 읽지 않으므로, 이 구역은 화면이 뜬 뒤 브라우저에서만 `GET /api/v1/profiles/:handle/social`(세션을 읽음)을 부릅니다.
 *   보는 사람에 따라 달라지는 내용이 SSR HTML·payload에 들어가지 않습니다. 404(차단당함)면 `hidden`을 알려 화면이 "찾을 수 없음"으로 바뀝니다.
 * - 팔로워 수는 응답에 키가 있을 때만(주인이 끄면 아예 없음) 보입니다. 팔로우 목록은 `follow_lists` 공개 범위를 통과할 때만 열립니다.
 * - 팔로우 주체: 내 프로필이 둘이면 어느 프로필로 할지 고릅니다. 표시명으로 팔로우하면 상대에게는 표시명만 보입니다.
 * - 차단·뮤트는 상대에게 알리지 않습니다. "내 모든 프로필에서" 차단은 연결 추정 경고를 확인해야 합니다.
 */
import { BLOCK_LINK_WARNING, BLOCK_SCOPE_LABELS, type BlockScope } from '@peerchive/domain'
import type { FollowListDto, FollowResultDto, MyBlockDto, MyMuteDto, ProfileSocialDto } from '~~/shared/types/api'

const props = defineProps<{ handle: string }>()
const emit = defineEmits<{ hidden: [] }>()

const social = ref<ProfileSocialDto | null>(null)
const actingId = ref('')
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const lists = reactive<{ followers: FollowListDto | null; following: FollowListDto | null }>({ followers: null, following: null })
const openList = ref<'followers' | 'following' | null>(null)
const blockScope = ref<BlockScope>('origin_persona')
const confirmLink = ref(false)

const path = computed(() => `/api/v1/profiles/${encodeURIComponent(props.handle)}`)
const acting = computed(() => social.value?.viewer?.personas.find((p) => p.personaId === actingId.value) ?? null)
const hasOtherPersona = computed(() => (social.value?.viewer?.personas.length ?? 0) > 1)
const needsLinkConfirm = computed(() => blockScope.value === 'all_personas' && hasOtherPersona.value)

async function load() {
  try {
    social.value = await $fetch<ProfileSocialDto>(`${path.value}/social`)
    const mine = social.value.viewer?.personas ?? []
    if (!mine.some((p) => p.personaId === actingId.value)) actingId.value = mine[0]?.personaId ?? ''
  } catch (error) {
    if (apiError(error).status === 404) emit('hidden')
    social.value = null
  }
}
onMounted(load)

async function run(task: () => Promise<string>) {
  busy.value = true
  notice.value = null
  try {
    notice.value = { kind: 'ok', text: await task() }
    await load()
  } catch (error) {
    const e = apiError(error)
    const text =
      e.code === 'own_persona'
        ? '내 프로필은 팔로우·차단할 수 없습니다.'
        : e.code === 'blocked_by_you'
          ? '이 프로필을 차단해 두었습니다. 차단을 해제한 뒤 팔로우할 수 있습니다.'
          : e.code === 'profile_required'
            ? '먼저 그 프로필의 공개 프로필을 만드세요.'
            : e.fields.confirmLinkInference === 'required'
              ? `${BLOCK_LINK_WARNING}. 확인란을 체크하세요.`
              : e.status === 429
                ? '팔로우 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.'
                : e.status === 404
                  ? '프로필을 찾을 수 없습니다.'
                  : '처리하지 못했습니다. 다시 시도하세요.'
    notice.value = { kind: 'error', text }
    if (e.status === 404) emit('hidden')
  } finally {
    busy.value = false
  }
}

const follow = () =>
  run(async () => {
    const res = await $fetch<FollowResultDto>(`${path.value}/follow`, { method: 'POST', body: { as: actingId.value } })
    return res.status === 'pending' ? '팔로우를 요청했습니다. 상대가 승인하면 팔로워가 됩니다.' : '팔로우했습니다.'
  })
const unfollow = () =>
  run(async () => {
    const pending = acting.value?.follow === 'pending'
    await $fetch(`${path.value}/follow`, { method: 'DELETE', query: { as: actingId.value } })
    return pending ? '팔로우 요청을 취소했습니다.' : '팔로우를 취소했습니다.'
  })
const block = () =>
  run(async () => {
    await $fetch<MyBlockDto>('/api/v1/blocks', {
      method: 'POST',
      body: { handle: props.handle, as: actingId.value, scope: blockScope.value, confirmLinkInference: needsLinkConfirm.value ? confirmLink.value : undefined },
    })
    confirmLink.value = false
    return '차단했습니다. 상대에게는 알리지 않습니다.'
  })
const unblock = (id: string) =>
  run(async () => {
    await $fetch(`/api/v1/blocks/${id}`, { method: 'DELETE' })
    return '차단을 해제했습니다.'
  })
const mute = () =>
  run(async () => {
    await $fetch<MyMuteDto>('/api/v1/mutes', { method: 'POST', body: { handle: props.handle } })
    return '뮤트했습니다. 팔로우 피드·알림에서만 빠지며 상대에게 알리지 않습니다.'
  })
const unmute = (id: string) =>
  run(async () => {
    await $fetch(`/api/v1/mutes/${id}`, { method: 'DELETE' })
    return '뮤트를 해제했습니다.'
  })

async function toggleList(kind: 'followers' | 'following') {
  if (openList.value === kind) {
    openList.value = null
    return
  }
  openList.value = kind
  try {
    lists[kind] = await $fetch<FollowListDto>(`${path.value}/${kind}`)
  } catch {
    lists[kind] = { entries: null }
  }
}
</script>

<template>
  <section v-if="social" class="profile-social stack" aria-labelledby="social-heading">
    <h2 id="social-heading" class="visually-hidden">팔로우</h2>
    <p class="actions small">
      <span v-if="social.accountPrivacy === 'private'" class="badge private">비공개 계정</span>
      <template v-if="social.followCounts">
        <button v-if="social.followListsVisible" type="button" class="link-button" :aria-expanded="openList === 'followers'" @click="toggleList('followers')">
          팔로워 {{ social.followCounts.followers }}
        </button>
        <span v-else>팔로워 {{ social.followCounts.followers }}</span>
        <button v-if="social.followListsVisible" type="button" class="link-button" :aria-expanded="openList === 'following'" @click="toggleList('following')">
          팔로잉 {{ social.followCounts.following }}
        </button>
        <span v-else>팔로잉 {{ social.followCounts.following }}</span>
      </template>
      <template v-else-if="social.followListsVisible">
        <button type="button" class="link-button" :aria-expanded="openList === 'followers'" @click="toggleList('followers')">팔로워 목록</button>
        <button type="button" class="link-button" :aria-expanded="openList === 'following'" @click="toggleList('following')">팔로잉 목록</button>
      </template>
      <NuxtLink v-if="social.isOwner" to="/settings/follows">팔로우 관리</NuxtLink>
    </p>

    <div v-if="openList && lists[openList]" class="small">
      <p v-if="lists[openList]!.entries === null" class="muted">이 목록은 볼 수 없습니다.</p>
      <p v-else-if="!lists[openList]!.entries!.length" class="muted">{{ openList === 'followers' ? '팔로워가 없습니다.' : '팔로우하는 프로필이 없습니다.' }}</p>
      <ul v-else class="plain" :aria-label="openList === 'followers' ? '팔로워' : '팔로잉'">
        <li v-for="e in lists[openList]!.entries!" :key="e.handle">
          <NuxtLink :to="`/u/${e.handle}`">{{ e.displayName }} @{{ e.handle }}</NuxtLink>
          <span v-if="e.kind === 'display'" class="muted"> · 표시명 프로필</span>
        </li>
      </ul>
    </div>

    <template v-if="social.viewer">
      <p v-if="!social.viewer.personas.length" class="hint">팔로우하려면 먼저 <NuxtLink to="/onboarding">공개 프로필</NuxtLink>을 만드세요.</p>
      <template v-else>
        <div v-if="social.viewer.personas.length > 1" class="field">
          <label for="acting-persona">어느 프로필로</label>
          <select id="acting-persona" v-model="actingId">
            <option v-for="p in social.viewer.personas" :key="p.personaId" :value="p.personaId">
              {{ p.kind === 'real' ? '실명 프로필' : '표시명 프로필' }} — {{ p.displayName }} @{{ p.handle }}
            </option>
          </select>
          <p class="hint">표시명 프로필로 팔로우하면 상대에게는 표시명만 보입니다.</p>
        </div>
        <p v-if="acting" class="actions">
          <button v-if="acting.follow === 'none' && !acting.block" type="button" :disabled="busy" @click="follow">
            {{ social.accountPrivacy === 'private' ? '팔로우 요청' : '팔로우' }}
          </button>
          <button v-else-if="acting.follow === 'pending'" type="button" class="secondary" :disabled="busy" @click="unfollow">요청 취소(승인 대기 중)</button>
          <button v-else-if="acting.follow === 'active'" type="button" class="secondary" :disabled="busy" @click="unfollow">팔로우 취소</button>
        </p>
        <details class="small">
          <summary>차단·뮤트</summary>
          <div class="stack">
            <template v-if="acting?.block">
              <p>
                이 프로필을 차단했습니다({{ BLOCK_SCOPE_LABELS[acting.block.scope] }} 숨김).
                <button type="button" class="link-button" :disabled="busy" @click="unblock(acting.block.id)">차단 해제</button>
              </p>
            </template>
            <fieldset v-else class="stack">
              <legend>차단하기</legend>
              <p class="hint">차단하면 상대는 내 프로필을 볼 수 없고(찾을 수 없음으로 보임), 서로의 팔로우가 끊깁니다. 상대에게 알리지 않습니다. 익명 커뮤니티 글에는 적용되지 않습니다.</p>
              <label v-for="scope in (['origin_persona', 'all_personas'] as const)" :key="scope" class="check">
                <input v-model="blockScope" type="radio" name="block-scope" :value="scope" />
                {{ scope === 'origin_persona' ? `${acting?.kind === 'display' ? '내 표시명 프로필' : '내 실명 프로필'}에서만 숨기기` : '내 모든 프로필에서 숨기기' }}
              </label>
              <template v-if="needsLinkConfirm">
                <p class="notice error" role="note">{{ BLOCK_LINK_WARNING }}. 두 프로필이 함께 사라지면 상대가 두 프로필을 같은 사람으로 짐작할 수 있습니다.</p>
                <label class="check"><input v-model="confirmLink" type="checkbox" /> 알고 있으며 모든 프로필에서 숨깁니다</label>
              </template>
              <p class="actions"><button type="button" class="danger" :disabled="busy || (needsLinkConfirm && !confirmLink)" @click="block">차단</button></p>
            </fieldset>
            <p>
              <button v-if="social.viewer.muteId" type="button" class="link-button" :disabled="busy" @click="unmute(social.viewer.muteId)">뮤트 해제</button>
              <button v-else type="button" class="link-button" :disabled="busy" @click="mute">뮤트</button>
              <span class="hint"> 뮤트는 팔로우 피드·알림에서만 빠집니다.</span>
            </p>
          </div>
        </details>
      </template>
    </template>
    <p v-else-if="!social.isOwner" class="hint small"><NuxtLink to="/login">로그인</NuxtLink>하면 팔로우할 수 있습니다.</p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
  </section>
</template>
