<script setup lang="ts">
/**
 * 팔로우·비공개 계정·차단·뮤트 관리(S-04, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1·§8.3, DELIVERY_PLAN §5.2 T·U, ADR 0033).
 * - 페르소나(실명·표시명)마다: 계정 공개 여부(비공개면 팔로우 요청을 승인해야 팔로워가 됨)·팔로워 수 표시, 받은 요청(승인·거절), 팔로워(삭제),
 *   팔로잉(취소), 보낸 요청(취소). 거절·삭제·취소는 상대에게 알리지 않습니다.
 * - **비공개 → 공개로 바꿀 때 대기 요청을 자동 승인하지 않습니다.** 대기 요청이 있으면 저장 전에 "모두 승인 / 모두 거절 / 그대로 두기"를 묻습니다.
 * - 내 차단·뮤트 목록(해제). 차단 목록에는 내가 차단한 그 프로필만 보입니다.
 */
import type { MyBlocksDto, MyFollowEntryDto, MyFollowsDto, MyMutesDto, MyPersonaDto, MyPersonasDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '팔로우·차단 — Peerchive' })

const requestFetch = useRequestFetch()
const { data: mine, refresh: refreshPersonas } = await useAsyncData('follows-personas', () => requestFetch<MyPersonasDto>('/api/v1/me/personas'))
const personas = computed(() => (mine.value?.personas ?? []).filter((p) => p.profile))
const route = useRoute()
const selectedId = ref<string>(
  personas.value.find((p) => p.id === route.query.persona)?.id ?? personas.value.find((p) => p.kind === 'real')?.id ?? personas.value[0]?.id ?? '',
)
const selected = computed<MyPersonaDto | null>(() => personas.value.find((p) => p.id === selectedId.value) ?? null)

const { data: follows, refresh: refreshFollows } = await useAsyncData(
  () => `my-follows:${selectedId.value}`,
  () => (selectedId.value ? requestFetch<MyFollowsDto>(`/api/v1/personas/${selectedId.value}/follows`) : Promise.resolve(null)),
  { watch: [selectedId] },
)
const { data: blocks, refresh: refreshBlocks } = await useAsyncData('my-blocks', () => requestFetch<MyBlocksDto>('/api/v1/me/blocks'))
const { data: mutes, refresh: refreshMutes } = await useAsyncData('my-mutes', () => requestFetch<MyMutesDto>('/api/v1/me/mutes'))

const privacy = ref<'public' | 'private'>('public')
const showCount = ref(true)
watch(
  selected,
  (p) => {
    privacy.value = p?.accountPrivacy ?? 'public'
    showCount.value = p?.showFollowerCount ?? true
  },
  { immediate: true },
)

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
/** 비공개 → 공개 전환 확인(대기 요청이 있을 때만). */
const askPending = ref(false)
const pendingChoice = ref<'keep' | 'approve_all' | 'reject_all'>('keep')

const settingsChanged = computed(() => !!selected.value && (privacy.value !== selected.value.accountPrivacy || showCount.value !== selected.value.showFollowerCount))
const openingUp = computed(() => selected.value?.accountPrivacy === 'private' && privacy.value === 'public')

async function act(key: string, task: () => Promise<string>) {
  busy.value = key
  notice.value = null
  try {
    notice.value = { kind: 'ok', text: await task() }
  } catch {
    notice.value = { kind: 'error', text: '처리하지 못했습니다. 다시 시도하세요.' }
  } finally {
    busy.value = null
    await Promise.all([refreshFollows(), refreshPersonas()])
  }
}

function saveSettings() {
  if (!selected.value || !settingsChanged.value) return
  if (openingUp.value && (follows.value?.incoming.length ?? 0) > 0 && !askPending.value) {
    askPending.value = true
    pendingChoice.value = 'keep'
    return
  }
  const id = selected.value.id
  return act('settings', async () => {
    await $fetch(`/api/v1/personas/${id}`, { method: 'PATCH', body: { accountPrivacy: privacy.value, showFollowerCount: showCount.value } })
    let extra = ''
    if (askPending.value && pendingChoice.value !== 'keep') {
      await $fetch(`/api/v1/personas/${id}/follow-requests`, { method: 'POST', body: { action: pendingChoice.value } })
      extra = pendingChoice.value === 'approve_all' ? ' 대기 중인 요청을 모두 승인했습니다.' : ' 대기 중인 요청을 모두 거절했습니다.'
    } else if (askPending.value) extra = ' 대기 중인 요청은 그대로 두었습니다.'
    askPending.value = false
    return `설정을 저장했습니다.${extra}`
  })
}

function cancelSwitch() {
  askPending.value = false
}

const approve = (e: MyFollowEntryDto) => act(e.id, async () => (await $fetch(`/api/v1/follow-requests/${e.id}/approve`, { method: 'POST' }), `@${e.handle}의 요청을 승인했습니다.`))
const reject = (e: MyFollowEntryDto) => act(e.id, async () => (await $fetch(`/api/v1/follow-requests/${e.id}/reject`, { method: 'POST' }), `@${e.handle}의 요청을 거절했습니다. 상대에게 알리지 않습니다.`))
const removeFollower = (e: MyFollowEntryDto) => act(e.id, async () => (await $fetch(`/api/v1/followers/${e.id}`, { method: 'DELETE' }), `@${e.handle}을(를) 팔로워에서 삭제했습니다. 상대에게 알리지 않습니다.`))
const unfollow = (e: MyFollowEntryDto, pending: boolean) =>
  act(e.id, async () => {
    await $fetch(`/api/v1/profiles/${encodeURIComponent(e.handle)}/follow`, { method: 'DELETE', query: { as: selectedId.value } })
    return pending ? `@${e.handle}에게 보낸 요청을 취소했습니다.` : `@${e.handle} 팔로우를 취소했습니다.`
  })
const unblock = (id: string, handle: string) =>
  act(id, async () => {
    await $fetch(`/api/v1/blocks/${id}`, { method: 'DELETE' })
    await refreshBlocks()
    return `@${handle} 차단을 해제했습니다.`
  })
const unmute = (id: string, handle: string) =>
  act(id, async () => {
    await $fetch(`/api/v1/mutes/${id}`, { method: 'DELETE' })
    await refreshMutes()
    return `@${handle} 뮤트를 해제했습니다.`
  })
const kindLabel = (k: 'real' | 'display') => (k === 'real' ? '실명 프로필' : '표시명 프로필')
</script>

<template>
  <div>
    <h1>팔로우·차단</h1>
    <p class="hint">
      팔로우는 프로필(실명·표시명)마다 따로입니다. 표시명 프로필로 팔로우하면 상대에게는 표시명만 보입니다. 요청 거절·팔로워 삭제·차단·뮤트는 상대에게
      알리지 않습니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <p v-if="!personas.length" class="notice error">먼저 <NuxtLink to="/onboarding">실명 프로필</NuxtLink>을 만드세요.</p>
    <template v-else>
      <fieldset v-if="personas.length > 1" class="stack">
        <legend>프로필</legend>
        <label v-for="p in personas" :key="p.id" class="check">
          <input v-model="selectedId" type="radio" name="persona" :value="p.id" />
          {{ kindLabel(p.kind) }} — {{ p.displayName }} @{{ p.handle }}
          <span v-if="p.pendingFollowRequests" class="badge">요청 {{ p.pendingFollowRequests }}</span>
        </label>
      </fieldset>

      <section v-if="selected" aria-labelledby="account-heading">
        <h2 id="account-heading">{{ kindLabel(selected.kind) }} 공개 설정</h2>
        <form class="stack" novalidate @submit.prevent="saveSettings">
          <fieldset class="stack">
            <legend>계정 공개</legend>
            <label class="check"><input v-model="privacy" type="radio" name="privacy" value="public" :disabled="askPending" /> 공개 계정 — 팔로우하면 바로 팔로워가 됩니다</label>
            <label class="check"><input v-model="privacy" type="radio" name="privacy" value="private" :disabled="askPending" /> 비공개 계정 — 내가 승인한 사람만 팔로워가 됩니다</label>
            <p class="hint">비공개 계정은 이름·소개 같은 기본 정보만 보이고, 나머지 항목은 승인한 팔로워까지만 보입니다(<NuxtLink to="/settings/visibility">공개 범위</NuxtLink>).</p>
          </fieldset>
          <label class="check"><input v-model="showCount" type="checkbox" :disabled="askPending" /> 공개 프로필에 팔로워·팔로잉 수 보이기</label>
          <div v-if="askPending" class="notice stack" role="alertdialog" aria-labelledby="pending-heading">
            <h3 id="pending-heading">대기 중인 팔로우 요청 {{ follows?.incoming.length }}건</h3>
            <p>공개 계정으로 바꿔도 대기 중인 요청은 자동으로 승인되지 않습니다. 어떻게 할까요?</p>
            <label class="check"><input v-model="pendingChoice" type="radio" name="pending-choice" value="approve_all" /> 모두 승인</label>
            <label class="check"><input v-model="pendingChoice" type="radio" name="pending-choice" value="reject_all" /> 모두 거절(상대에게 알리지 않음)</label>
            <label class="check"><input v-model="pendingChoice" type="radio" name="pending-choice" value="keep" /> 그대로 두기(나중에 하나씩 처리)</label>
            <p class="actions">
              <button type="submit" :disabled="busy === 'settings'">공개 계정으로 바꾸기</button>
              <button type="button" class="secondary" @click="cancelSwitch">돌아가기</button>
            </p>
          </div>
          <p v-else class="actions"><button type="submit" :disabled="busy === 'settings' || !settingsChanged">설정 저장</button></p>
        </form>
      </section>

      <template v-if="follows">
        <section aria-labelledby="incoming-heading">
          <h2 id="incoming-heading">받은 팔로우 요청</h2>
          <p v-if="!follows.incoming.length" class="muted">대기 중인 요청이 없습니다.</p>
          <ul v-else class="plain stack">
            <li v-for="e in follows.incoming" :key="e.id" class="actions">
              <NuxtLink :to="`/u/${e.handle}`">{{ e.displayName }} @{{ e.handle }}</NuxtLink>
              <button type="button" :disabled="busy === e.id" :aria-label="`@${e.handle} 요청 승인`" @click="approve(e)">승인</button>
              <button type="button" class="secondary" :disabled="busy === e.id" :aria-label="`@${e.handle} 요청 거절`" @click="reject(e)">거절</button>
            </li>
          </ul>
        </section>

        <section aria-labelledby="followers-heading">
          <h2 id="followers-heading">팔로워 {{ follows.followers.length }}</h2>
          <p v-if="!follows.followers.length" class="muted">팔로워가 없습니다.</p>
          <ul v-else class="plain stack">
            <li v-for="e in follows.followers" :key="e.id" class="actions">
              <NuxtLink :to="`/u/${e.handle}`">{{ e.displayName }} @{{ e.handle }}</NuxtLink>
              <button type="button" class="secondary" :disabled="busy === e.id" :aria-label="`@${e.handle} 팔로워 삭제`" @click="removeFollower(e)">삭제</button>
            </li>
          </ul>
        </section>

        <section aria-labelledby="following-heading">
          <h2 id="following-heading">팔로잉 {{ follows.following.length }}</h2>
          <p v-if="!follows.following.length && !follows.outgoing.length" class="muted">팔로우하는 프로필이 없습니다.</p>
          <ul class="plain stack">
            <li v-for="e in follows.following" :key="e.id" class="actions">
              <NuxtLink :to="`/u/${e.handle}`">{{ e.displayName }} @{{ e.handle }}</NuxtLink>
              <button type="button" class="secondary" :disabled="busy === e.id" :aria-label="`@${e.handle} 팔로우 취소`" @click="unfollow(e, false)">팔로우 취소</button>
            </li>
            <li v-for="e in follows.outgoing" :key="e.id" class="actions">
              <NuxtLink :to="`/u/${e.handle}`">{{ e.displayName }} @{{ e.handle }}</NuxtLink> <span class="muted">승인 대기</span>
              <button type="button" class="secondary" :disabled="busy === e.id" :aria-label="`@${e.handle} 요청 취소`" @click="unfollow(e, true)">요청 취소</button>
            </li>
          </ul>
        </section>
      </template>

      <section aria-labelledby="blocks-heading">
        <h2 id="blocks-heading">차단한 프로필</h2>
        <p class="hint">차단은 그 프로필의 페이지에서 합니다. 차단당한 사람에게 내 프로필은 "찾을 수 없음"으로 보이고, 익명 커뮤니티 글에는 적용되지 않습니다.</p>
        <p v-if="!blocks?.blocks.length" class="muted">차단한 프로필이 없습니다.</p>
        <ul v-else class="plain stack">
          <li v-for="b in blocks.blocks" :key="b.id" class="actions">
            <span>{{ b.target.displayName }} @{{ b.target.handle }}</span>
            <span class="muted small">
              {{ b.scope === 'all_personas' ? '내 모든 프로필에서 숨김' : `${kindLabel(b.origin.kind)} @${b.origin.handle}에서 숨김` }}
            </span>
            <button type="button" class="secondary" :disabled="busy === b.id" :aria-label="`@${b.target.handle} 차단 해제`" @click="unblock(b.id, b.target.handle)">차단 해제</button>
          </li>
        </ul>
      </section>

      <section aria-labelledby="mutes-heading">
        <h2 id="mutes-heading">뮤트한 프로필</h2>
        <p class="hint">뮤트는 팔로우 피드·알림에서만 빠집니다(피드는 준비 중). 상대에게 알리지 않습니다.</p>
        <p v-if="!mutes?.mutes.length" class="muted">뮤트한 프로필이 없습니다.</p>
        <ul v-else class="plain stack">
          <li v-for="m in mutes.mutes" :key="m.id" class="actions">
            <span>{{ m.target.displayName }} @{{ m.target.handle }}</span>
            <button type="button" class="secondary" :disabled="busy === m.id" :aria-label="`@${m.target.handle} 뮤트 해제`" @click="unmute(m.id, m.target.handle)">뮤트 해제</button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
