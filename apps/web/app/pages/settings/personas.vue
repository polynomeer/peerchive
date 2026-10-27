<script setup lang="ts">
/**
 * 표시명 프로필·실명 연결(S-01, PROOFU_EVOLUTION_PLAN §4.4·§10.7, SYSTEM_DESIGN §6.7.1, DELIVERY_PLAN §5.2 R, ADR 0028).
 * - 실명 프로필(채용자용 포트폴리오 기본)은 /onboarding에서 만들고 고칩니다. 여기서는 표시명 프로필 하나를 만들고 고칩니다.
 * - handle은 실명·표시명이 같은 공간을 씁니다(겹치면 "이미 사용 중"). 표시명 프로필에는 대표 케이스 스터디를 넣을 수 없습니다.
 * - 연결 표시는 기본으로 꺼져 있습니다. 켜면 두 공개 프로필에 서로의 링크가 보여 누구나 같은 사람임을 압니다. 끄면 다음 요청부터 사라집니다.
 */
import type { MyPersonaDto, MyPersonasDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '표시명 프로필 — Peerchive' })

const { data, refresh } = await useAsyncData('my-personas', () => useRequestFetch()<MyPersonasDto>('/api/v1/me/personas'))
const real = computed(() => data.value?.personas.find((p) => p.kind === 'real' && p.profile) ?? null)
const display = computed(() => data.value?.personas.find((p) => p.kind === 'display') ?? null)
const linkVisible = computed(() => data.value?.identityLink?.visible ?? false)

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)

const form = reactive({ handle: '', displayName: '', headline: '', schoolLabel: '', openToWork: false })
function fill(p: MyPersonaDto | null) {
  form.handle = p?.handle ?? ''
  form.displayName = p?.displayName ?? ''
  form.headline = p?.profile?.headline ?? ''
  form.schoolLabel = p?.profile?.schoolLabel ?? ''
  form.openToWork = p?.profile?.openToWork ?? false
}
watch(display, fill, { immediate: true })

async function save() {
  busy.value = 'save'
  notice.value = null
  errors.value = {}
  const creating = !display.value
  try {
    const body = { handle: form.handle, displayName: form.displayName, headline: form.headline || null, schoolLabel: form.schoolLabel || null, openToWork: form.openToWork }
    if (creating) await $fetch('/api/v1/personas', { method: 'POST', body })
    else await $fetch(`/api/v1/personas/${display.value!.id}`, { method: 'PATCH', body })
    await refresh()
    notice.value = { kind: 'ok', text: creating ? '표시명 프로필을 만들었습니다. 실명 프로필과의 연결은 꺼져 있습니다.' : '저장했습니다.' }
  } catch (error) {
    const e = apiError(error)
    if (e.status === 422) {
      errors.value = e.fields
      notice.value = { kind: 'error', text: '입력한 내용을 확인하세요.' }
    } else if (e.code === 'real_persona_required') {
      notice.value = { kind: 'error', text: '먼저 실명 프로필을 만드세요.' }
    } else if (e.code === 'persona_exists') {
      notice.value = { kind: 'error', text: '표시명 프로필은 하나만 만들 수 있습니다.' }
      await refresh()
    } else {
      notice.value = { kind: 'error', text: '저장하지 못했습니다. 입력한 내용은 그대로 있으니 다시 시도하세요.' }
    }
  } finally {
    busy.value = null
  }
}

async function setLink(visible: boolean) {
  if (visible && !window.confirm('연결을 켜면 누구나 두 공개 프로필이 같은 사람이라는 것을 알 수 있습니다. 나중에 끄더라도 그 사이 본 사람이나 저장된 사본에서는 되돌릴 수 없습니다. 켤까요?')) return
  busy.value = 'link'
  notice.value = null
  try {
    data.value = await $fetch<MyPersonasDto>('/api/v1/me/identity-link', { method: 'PUT', body: { visible } })
    notice.value = { kind: 'ok', text: visible ? '두 프로필에 서로의 링크를 보입니다.' : '연결을 껐습니다. 다음 요청부터 두 프로필에 서로의 정보가 보이지 않습니다.' }
  } catch {
    notice.value = { kind: 'error', text: '설정을 바꾸지 못했습니다. 다시 시도하세요.' }
  } finally {
    busy.value = null
  }
}

const err = (field: string) => fieldMessage(errors.value[field])
</script>

<template>
  <div>
    <h1>표시명 프로필</h1>
    <p class="hint">
      실명 프로필과 따로 쓰는 공개 프로필을 하나 만들 수 있습니다. 표시명 프로필에는 실명 프로필의 이름·주소·소개·과제 기록이 보이지 않고,
      실명 프로필에도 표시명 프로필이 보이지 않습니다. 채용 담당자에게 보이는 포트폴리오는 실명 프로필이 기본입니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <p v-if="!real" class="notice error">먼저 <NuxtLink to="/onboarding">실명 프로필</NuxtLink>을 만드세요.</p>
    <template v-else>
      <p class="small">실명 프로필: <NuxtLink :to="`/u/${real.handle}`">{{ real.displayName }} @{{ real.handle }}</NuxtLink> (<NuxtLink to="/onboarding">고치기</NuxtLink>)</p>

      <section aria-labelledby="display-heading">
        <h2 id="display-heading">{{ display ? '표시명 프로필 고치기' : '표시명 프로필 만들기' }}</h2>
        <p v-if="display" class="small">
          공개 주소: <NuxtLink :to="`/u/${display.handle}`">/u/{{ display.handle }}</NuxtLink>
          · <NuxtLink :to="`/portfolio/edition?persona=${display.id}`">이 프로필의 포트폴리오 판 만들기</NuxtLink>
          <template v-if="display.profileHidden"> · <strong>운영 조치로 숨겨진 프로필입니다.</strong></template>
        </p>
        <form class="stack" novalidate @submit.prevent="save">
          <div class="field">
            <label for="persona-handle">핸들 (필수)</label>
            <input
              id="persona-handle"
              v-model="form.handle"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="30"
              :aria-invalid="errors.handle ? 'true' : undefined"
              aria-describedby="persona-handle-hint"
            />
            <p id="persona-handle-hint" class="hint">3–30자, 영문 소문자·숫자·하이픈(-). 실명 프로필과 같은 핸들은 쓸 수 없습니다.</p>
            <p v-if="err('handle')" class="field-error">{{ err('handle') }}</p>
          </div>
          <div class="field">
            <label for="persona-name">표시명 (필수)</label>
            <input id="persona-name" v-model="form.displayName" maxlength="50" :aria-invalid="errors.displayName ? 'true' : undefined" />
            <p v-if="err('displayName')" class="field-error">{{ err('displayName') }}</p>
          </div>
          <div class="field">
            <label for="persona-headline">한 줄 소개 (선택)</label>
            <input id="persona-headline" v-model="form.headline" maxlength="120" />
            <p v-if="err('headline')" class="field-error">{{ err('headline') }}</p>
          </div>
          <div class="field">
            <label for="persona-school">학교 (선택, 본인 입력)</label>
            <input id="persona-school" v-model="form.schoolLabel" maxlength="80" aria-describedby="persona-school-hint" />
            <p id="persona-school-hint" class="hint">실명 프로필과 같은 값을 넣으면 두 프로필이 같은 사람으로 추정될 수 있습니다.</p>
          </div>
          <label class="check"><input v-model="form.openToWork" type="checkbox" /> 구직 중 표시</label>
          <p class="actions">
            <button type="submit" :disabled="busy === 'save'">{{ display ? '저장' : '만들기' }}</button>
          </p>
        </form>
      </section>

      <section v-if="display" aria-labelledby="link-heading">
        <h2 id="link-heading">실명 프로필과 연결 표시</h2>
        <p class="hint">
          지금은 <strong>{{ linkVisible ? '켜져 있습니다' : '꺼져 있습니다' }}</strong>.
          켜면 두 공개 프로필(화면·인쇄 보기·README 카드)에 서로의 링크가 보여 <strong>누구나 두 프로필이 같은 사람이라는 것을 알 수 있습니다</strong>.
          끄면 다음 요청부터 링크가 사라지지만, 그 사이 본 사람이나 저장된 사본에서는 되돌릴 수 없습니다. 켜고 끈 기록은 감사 기록에만 남습니다.
        </p>
        <p class="actions">
          <button v-if="!linkVisible" type="button" class="secondary" :disabled="busy === 'link'" @click="setLink(true)">연결 켜기</button>
          <button v-else type="button" :disabled="busy === 'link'" @click="setLink(false)">연결 끄기</button>
        </p>
      </section>
    </template>
  </div>
</template>
