<script setup lang="ts">
/**
 * 페르소나 하나의 소셜 링크 관리(S-06, ADR 0034). 링크는 페르소나마다 따로이고, 같은 주소를 내 다른 프로필에 걸 수 없습니다.
 * - 추가 → "확인 요청" → worker가 그 페이지를 가져와 이 프로필 주소로 돌아오는 링크가 있는지 봅니다(웹 서버는 접속하지 않음).
 * - 확인 중이면 몇 초마다 다시 읽습니다(최대 30초). 결과 문구는 본인에게만 보입니다.
 * - `링크 확인됨`은 계정에 프로필 링크가 있다는 것만 확인합니다. 인물·경력 검증이 아니라는 설명을 함께 둡니다.
 */
import {
  SOCIAL_LINK_CHECK_RESULT_TEXT,
  SOCIAL_LINK_PROVIDERS,
  SOCIAL_LINK_PROVIDER_LABELS,
  SOCIAL_LINK_VERIFICATION_LABELS,
  SOCIAL_LINK_VERIFIED_NOTE,
  type SocialLinkProvider,
} from '@peerchive/domain'
import type { MySocialLinksDto } from '~~/shared/types/api'

const props = defineProps<{ personaId: string; label: string }>()

const { data, refresh } = await useAsyncData(`social-links:${props.personaId}`, () =>
  useRequestFetch()<MySocialLinksDto>(`/api/v1/personas/${props.personaId}/social-links`),
)

const URL_ERRORS: Record<string, string> = {
  invalid: '주소 형식을 확인하세요(https://로 시작하는 전체 주소).',
  too_long: '주소가 너무 깁니다(300자까지).',
  scheme: 'https:// 주소만 넣을 수 있습니다.',
  credentials: '아이디·비밀번호가 들어간 주소는 넣을 수 없습니다.',
  port: '포트 번호가 붙은 주소는 넣을 수 없습니다.',
  ip_literal: 'IP 주소 대신 도메인 주소를 넣으세요.',
  host: '공개 인터넷 주소가 아닙니다(localhost·내부망 이름 등).',
  provider_mismatch: '고른 서비스의 주소가 아닙니다. 서비스를 "블로그"나 "기타"로 바꾸거나 주소를 확인하세요.',
}
const CONFLICTS: Record<string, string> = {
  limit_reached: '링크는 프로필마다 8개까지 넣을 수 있습니다.',
  duplicate: '이미 넣은 링크입니다.',
  used_by_other_persona: '내 다른 프로필에 이미 넣은 주소입니다. 두 프로필이 같은 사람으로 이어지지 않도록 같은 주소는 한 프로필에만 넣을 수 있습니다.',
  profile_required: '먼저 이 프로필을 만드세요.',
  persona_inactive: '비활성 프로필의 링크는 확인할 수 없습니다.',
}

const form = reactive<{ provider: SocialLinkProvider; url: string }>({ provider: 'github', url: '' })
const urlError = ref<string | null>(null)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
const id = (s: string) => `sl-${props.personaId.slice(0, 8)}-${s}`

function failed(error: unknown, fallback: string) {
  const e = apiError(error)
  if (e.status === 429) notice.value = { kind: 'error', text: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.' }
  else notice.value = { kind: 'error', text: CONFLICTS[e.code] ?? fallback }
  return e
}

async function add() {
  busy.value = 'add'
  notice.value = null
  urlError.value = null
  try {
    await $fetch(`/api/v1/personas/${props.personaId}/social-links`, { method: 'POST', body: { provider: form.provider, url: form.url } })
    form.url = ''
    await refresh()
    notice.value = { kind: 'ok', text: '링크를 넣었습니다. 아래 주소를 그 페이지에 넣은 뒤 "확인 요청"을 누르면 확인 표시가 붙습니다.' }
  } catch (error) {
    const e = apiError(error)
    if (e.status === 422 && e.fields.url) urlError.value = URL_ERRORS[e.fields.url] ?? URL_ERRORS.invalid!
    else failed(error, '넣지 못했습니다. 다시 시도하세요.')
  } finally {
    busy.value = null
  }
}

async function remove(linkId: string) {
  busy.value = linkId
  notice.value = null
  try {
    await $fetch(`/api/v1/social-links/${linkId}`, { method: 'DELETE' })
    await refresh()
    notice.value = { kind: 'ok', text: '링크를 지웠습니다.' }
  } catch (error) {
    failed(error, '지우지 못했습니다. 다시 시도하세요.')
  } finally {
    busy.value = null
  }
}

let polls = 0
let timer: ReturnType<typeof setTimeout> | null = null
function pollWhilePending() {
  if (timer) clearTimeout(timer)
  if (!data.value?.links.some((l) => l.verifyPending) || polls >= 10) return
  timer = setTimeout(async () => {
    polls++
    await refresh()
    pollWhilePending()
  }, 3000)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function verify(linkId: string) {
  busy.value = linkId
  notice.value = null
  try {
    await $fetch(`/api/v1/social-links/${linkId}/verify`, { method: 'POST' })
    await refresh()
    polls = 0
    pollWhilePending()
  } catch (error) {
    failed(error, '확인을 요청하지 못했습니다. 다시 시도하세요.')
  } finally {
    busy.value = null
  }
}
onMounted(pollWhilePending)

const short = (url: string) => url.replace(/^https:\/\//, '').replace(/\/$/, '')
</script>

<template>
  <section :aria-labelledby="id('heading')" class="social-links-editor">
    <h3 :id="id('heading')">{{ label }}</h3>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <template v-if="data">
      <p class="hint">
        확인을 받으려면 링크한 페이지(예: GitHub 프로필의 Website 칸)에 이 주소를 넣으세요: <code>{{ data.backLinkUrl }}</code>
      </p>
      <ul v-if="data.links.length" class="plain stack">
        <li v-for="link in data.links" :key="link.id" class="social-link-row">
          <p>
            <strong>{{ SOCIAL_LINK_PROVIDER_LABELS[link.provider] }}</strong> ·
            <a :href="link.url" rel="nofollow noopener noreferrer" target="_blank">{{ short(link.url) }}</a>
            <span :class="['badge', { private: link.verification !== 'verified' }]">{{ link.verifyPending ? '확인 중…' : SOCIAL_LINK_VERIFICATION_LABELS[link.verification] }}</span>
          </p>
          <p v-if="link.lastCheckResult && !link.verifyPending" class="small muted">
            {{ SOCIAL_LINK_CHECK_RESULT_TEXT[link.lastCheckResult] }}<template v-if="link.lastCheckedAt"> ({{ formatDateTime(link.lastCheckedAt) }})</template>
          </p>
          <p v-if="link.verification === 'lost'" class="small">다시 확인할 때까지 공개 프로필에서 확인 표시가 빠집니다.</p>
          <p class="actions small">
            <button type="button" class="secondary" :disabled="busy === link.id || link.verifyPending" @click="verify(link.id)">확인 요청</button>
            <button type="button" class="secondary" :disabled="busy === link.id" @click="remove(link.id)">지우기</button>
          </p>
        </li>
      </ul>
      <p v-else class="small muted">아직 넣은 링크가 없습니다.</p>
      <form v-if="data.links.length < data.limit" class="stack" novalidate @submit.prevent="add">
        <div class="field">
          <label :for="id('provider')">서비스</label>
          <select :id="id('provider')" v-model="form.provider">
            <option v-for="p in SOCIAL_LINK_PROVIDERS" :key="p" :value="p">{{ SOCIAL_LINK_PROVIDER_LABELS[p] }}</option>
          </select>
        </div>
        <div class="field">
          <label :for="id('url')">주소 (https://)</label>
          <input
            :id="id('url')"
            v-model="form.url"
            type="url"
            inputmode="url"
            autocomplete="off"
            maxlength="300"
            placeholder="https://github.com/내아이디"
            :aria-invalid="urlError ? 'true' : undefined"
          />
          <p v-if="urlError" class="field-error">{{ urlError }}</p>
        </div>
        <p class="actions"><button type="submit" :disabled="busy === 'add' || !form.url.trim()">링크 넣기</button></p>
      </form>
      <p v-else class="small muted">링크는 프로필마다 {{ data.limit }}개까지입니다.</p>
      <p class="hint">“링크 확인됨”은 {{ SOCIAL_LINK_VERIFIED_NOTE }}. 확인된 링크는 하루에 한 번 다시 확인하며, 프로필 링크를 지우면 확인 표시가 빠집니다.</p>
    </template>
  </section>
</template>

<style scoped>
.social-links-editor code,
.social-link-row a {
  overflow-wrap: anywhere;
}
</style>
