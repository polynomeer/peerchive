<script setup lang="ts">
/**
 * 공개 프로필의 활동 목록과 (본인이면) 프로필 글 쓰기(S-05, SYSTEM_DESIGN §6.7.1 ProfilePost·PersonaActivity·§8.3, ADR 0035).
 * - 공개 화면 SSR은 로그인 상태를 읽지 않으므로 이 구역은 화면이 뜬 뒤 브라우저에서만 `GET /api/v1/profiles/:handle/activity`(세션을 읽음)를 부릅니다.
 *   보는 사람에 따라 달라지는 목록이 SSR HTML·payload에 들어가지 않습니다. 404(차단당함)면 `hidden`을 알립니다.
 * - 탭은 보는 사람이 볼 수 있는 종류만(서버가 `kinds`로 줌). 볼 수 없는 종류는 왜 없는지 밝히지 않습니다.
 * - 본인 프로필이면(내 페르소나 목록에 이 handle이 있으면) 짧은 글 쓰기·지우기. 공개 범위는 `공개 범위` 설정의 "공개 글"을 따릅니다.
 */
import { PROFILE_POST_MAX } from '@peerchive/domain'
import type { ActivityItemDto, ActivityKindDto, MyPersonasDto, ProfileActivityDto } from '~~/shared/types/api'

const props = defineProps<{ handle: string }>()
const emit = defineEmits<{ hidden: [] }>()

const KIND_LABELS: Record<ActivityKindDto, string> = { cases: '공개 사례', notes_and_studies: '선배 노트·스터디 기록', posts: '글' }

const kinds = ref<ActivityKindDto[]>([])
const items = ref<ActivityItemDto[]>([])
const nextCursor = ref<string | null>(null)
const tab = ref<ActivityKindDto | ''>('')
const loaded = ref(false)
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const myPersonaId = ref<string | null>(null)
const draft = ref('')

const path = computed(() => `/api/v1/profiles/${encodeURIComponent(props.handle)}/activity`)
const remaining = computed(() => PROFILE_POST_MAX - [...draft.value.trim()].length)

async function load(more = false) {
  try {
    const res = await $fetch<ProfileActivityDto>(path.value, { query: { kind: tab.value || undefined, cursor: more ? nextCursor.value : undefined } })
    kinds.value = res.kinds
    items.value = more ? [...items.value, ...res.items] : res.items
    nextCursor.value = res.nextCursor
    loaded.value = true
  } catch (error) {
    if (apiError(error).status === 404) emit('hidden')
  }
}

onMounted(async () => {
  await load()
  try {
    const mine = await $fetch<MyPersonasDto>('/api/v1/me/personas')
    myPersonaId.value = mine.personas.find((p) => p.handle === props.handle && p.profile)?.id ?? null
  } catch {
    myPersonaId.value = null // 로그인하지 않음
  }
})
watch(tab, () => load())

async function post() {
  if (!myPersonaId.value) return
  busy.value = true
  notice.value = null
  try {
    await $fetch(`/api/v1/personas/${myPersonaId.value}/posts`, { method: 'POST', body: { body: draft.value } })
    draft.value = ''
    notice.value = { kind: 'ok', text: '글을 올렸습니다. 공개 범위 설정의 "공개 글" 범위에 보입니다.' }
    await load()
  } catch (error) {
    const e = apiError(error)
    notice.value = {
      kind: 'error',
      text:
        e.fields.body === 'required'
          ? '내용을 입력하세요.'
          : e.fields.body === 'too_long'
            ? `${PROFILE_POST_MAX}자까지 쓸 수 있습니다.`
            : e.status === 429
              ? '글을 너무 자주 올렸습니다. 잠시 뒤 다시 시도하세요.'
              : '올리지 못했습니다. 다시 시도하세요.',
    }
  } finally {
    busy.value = false
  }
}

async function remove(item: ActivityItemDto) {
  if (!myPersonaId.value || !item.profilePostId) return
  if (!confirm('이 글을 지울까요? 프로필과 팔로워 피드에서 바로 사라집니다.')) return
  busy.value = true
  try {
    await $fetch(`/api/v1/personas/${myPersonaId.value}/posts/${item.profilePostId}`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: '글을 지웠습니다.' }
    await load()
  } catch {
    notice.value = { kind: 'error', text: '지우지 못했습니다. 다시 시도하세요.' }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="loaded" class="stack" aria-labelledby="activity-heading">
    <h2 id="activity-heading">활동</h2>
    <form v-if="myPersonaId" class="stack" @submit.prevent="post">
      <label for="profile-post-body">프로필에 짧은 글 쓰기</label>
      <textarea id="profile-post-body" v-model="draft" rows="3" :maxlength="PROFILE_POST_MAX * 2" />
      <p class="hint">
        글만 올릴 수 있습니다(사진은 준비 중). 남은 글자 {{ remaining }}자.
        <NuxtLink to="/settings/visibility">공개 범위</NuxtLink>의 "공개 글"을 따릅니다.
      </p>
      <p class="actions"><button type="submit" :disabled="busy || !draft.trim() || remaining < 0">올리기</button></p>
    </form>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <div v-if="kinds.length > 1" class="actions small" role="group" aria-label="활동 종류">
      <button type="button" :class="tab === '' ? '' : 'secondary'" :aria-pressed="tab === ''" @click="tab = ''">전체</button>
      <button v-for="k in kinds" :key="k" type="button" :class="tab === k ? '' : 'secondary'" :aria-pressed="tab === k" @click="tab = k">
        {{ KIND_LABELS[k] }}
      </button>
    </div>
    <p v-if="!items.length" class="muted small">{{ kinds.length ? '아직 활동이 없습니다.' : '볼 수 있는 활동이 없습니다.' }}</p>
    <ActivityItem
      v-for="item in items"
      :key="item.id"
      :item="item"
      :deletable="!!myPersonaId && !!item.profilePostId"
      :busy="busy"
      @delete="remove(item)"
    />
    <p v-if="nextCursor"><button type="button" class="secondary" @click="load(true)">더 보기</button></p>
  </section>
</template>
