<script setup lang="ts">
/**
 * 동문회·OB 방의 멤버 명부 화면(A-03, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 DirectoryEntry, ADR 0040). 로그인 전용·noindex, 방 멤버에게만.
 * - 내 항목: 동의 설명을 읽고 체크해야 저장됩니다. 기수·지금 하는 일·관심사·연락 방법은 모두 선택이고 각각 비울 수 있습니다. 연락 방법은 방 멤버
 *   모두에게 보인다고 경고합니다. “동의 철회”는 내 행을 바로 지웁니다.
 * - 명부: 동의한 멤버의 동의한 항목만, 한 쪽에 최대 20명. 내보내기(CSV·PDF)·전체 보기는 없고, 짧은 시간에 많은 쪽을 넘기면 잠시 막힙니다(429).
 * - P2 alumni 플래그가 꺼져 있거나 멤버가 아니면 "찾을 수 없습니다"(서버 404). 익명 방에는 명부가 없습니다.
 * 방 밖(공개 프로필·검색·추천·피드·활동)에는 이 화면의 값이 나가지 않습니다.
 */
import type { DirectoryEntryDto, DirectoryPageDto, MyDirectoryEntryDto, SpaceDetailDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const fetcher = useRequestFetch()
const { data: space } = await useAsyncData(`directory-space-${slug.value}`, () => fetcher<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}`).catch(() => null))
const { data: state, error } = await useAsyncData(`directory-${slug.value}`, () => fetcher<DirectoryPageDto>(`/api/v1/community/spaces/${slug.value}/directory`))
const initialError = computed(() => apiError(error.value))
const unavailable = computed(() => initialError.value.code === 'directory_unavailable')
const limited = ref(initialError.value.status === 429)
const missing = computed(() => !state.value && !unavailable.value && !limited.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const RATE_LIMIT_TEXT = '짧은 시간에 명부를 너무 많이 넘겼습니다. 명부를 통째로 가져가지 못하게 막고 있으니 10분쯤 뒤 다시 보세요.'
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(limited.value ? { kind: 'error', text: RATE_LIMIT_TEXT } : null)
const busy = ref<string | null>(null)
const fieldErrors = ref<Record<string, string>>({})

const FIELD_TEXT: Record<string, string> = {
  required: '위 설명을 읽고 동의에 체크해야 저장됩니다.',
  too_long: '너무 깁니다.',
  too_many: `관심사는 ${DIRECTORY_INTERESTS_MAX}개까지입니다.`,
  invalid: '쓸 수 없는 값입니다(줄바꿈·제어 문자 등).',
}
const fieldText = (code: string | undefined) => (code ? (FIELD_TEXT[code] ?? fieldMessage(code)) : undefined)

const form = reactive({ consent: false, cohortLabel: '', currentWork: '', interests: '', contactMethod: '' })
function fillForm(mine: DirectoryEntryDto | null | undefined) {
  form.consent = false
  form.cohortLabel = mine?.cohortLabel ?? ''
  form.currentWork = mine?.currentWork ?? ''
  form.interests = (mine?.interests ?? []).join(', ')
  form.contactMethod = mine?.contactMethod ?? ''
}
const mine = ref<DirectoryEntryDto | null>(state.value?.mine ?? null)
fillForm(mine.value)

function fail(e: unknown) {
  const err = apiError(e)
  fieldErrors.value = err.fields
  if (err.status === 429 && busy.value?.startsWith('page')) {
    limited.value = true
    notice.value = { kind: 'error', text: RATE_LIMIT_TEXT }
    return
  }
  notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
}

async function goTo(page: number) {
  busy.value = `page-${page}`
  notice.value = null
  try {
    state.value = await $fetch<DirectoryPageDto>(`/api/v1/community/spaces/${slug.value}/directory`, { query: { page } })
    limited.value = false
    mine.value = state.value.mine
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

/** 저장·철회 뒤에는 쪽을 다시 받지 않고(조회 한도를 쓰지 않게) 보이는 목록에서 내 항목만 바꿉니다. */
function patchVisible(entry: DirectoryEntryDto | null) {
  mine.value = entry
  if (!state.value) return
  const others = state.value.entries.filter((e) => !e.mine)
  const had = state.value.entries.some((e) => e.mine)
  state.value = { ...state.value, mine: entry, entries: entry && had ? state.value.entries.map((e) => (e.mine ? entry : e)) : others }
}

async function save() {
  busy.value = 'save'
  notice.value = null
  fieldErrors.value = {}
  try {
    const res = await $fetch<MyDirectoryEntryDto>(`/api/v1/community/spaces/${slug.value}/directory/me`, {
      method: 'PUT',
      body: {
        consent: form.consent,
        cohortLabel: form.cohortLabel.trim() || null,
        currentWork: form.currentWork.trim() || null,
        interests: form.interests.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        contactMethod: form.contactMethod.trim() || null,
      },
    })
    const isNew = !mine.value
    patchVisible(res.entry)
    fillForm(res.entry)
    notice.value = { kind: 'ok', text: isNew ? '명부에 올렸습니다. 쪽을 넘기면 목록에서 보입니다.' : '명부 항목을 바꿨습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

async function withdraw() {
  if (!confirm('명부 동의를 철회할까요? 내 명부 항목이 바로 지워지고 되돌릴 수 없습니다.')) return
  busy.value = 'withdraw'
  notice.value = null
  try {
    await $fetch(`/api/v1/community/spaces/${slug.value}/directory/me`, { method: 'DELETE' })
    patchVisible(null)
    fillForm(null)
    notice.value = { kind: 'ok', text: '동의를 철회했습니다. 내 명부 항목을 지웠습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
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
      <h1>멤버 명부</h1>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <p v-if="unavailable" class="notice">익명 방에는 멤버 명부가 없습니다. 이름 없이 기수·관심사·연락 방법만 모이면 누구인지 드러날 수 있기 때문입니다.</p>

      <template v-if="state || (limited && !unavailable)">
        <section aria-labelledby="my-directory-entry">
          <h2 id="my-directory-entry">내 명부 항목</h2>
          <div class="hint" data-testid="directory-consent-text">
            <p>
              명부에는 <strong>동의한 멤버만, 적은 항목만</strong> 올라갑니다. 적은 내용은 <strong>이 방 멤버 모두</strong>에게 보이고, 방 밖(공개 프로필·검색·추천·피드)에는
              나가지 않습니다. 이름은 이 방의 이름 표시 방식을 따릅니다(실명 방은 실명, 표시명 방은 방별 프로필 이름).
            </p>
            <p>
              모든 항목은 선택이며 언제든 비우거나 고칠 수 있습니다. <strong>동의를 철회하거나 방을 나가면 내 항목은 바로 지워집니다.</strong> 명부를 파일(CSV·PDF)로 내보내거나 한 번에
              모두 보는 기능은 없습니다.
            </p>
          </div>
          <p v-if="mine" class="small"><span class="badge">명부에 올라 있음</span></p>
          <form v-if="state?.writable !== false" class="stack" novalidate @submit.prevent="save">
            <div class="field">
              <label for="dir-cohort">기수 (선택)</label>
              <input id="dir-cohort" v-model="form.cohortLabel" :maxlength="DIRECTORY_COHORT_LABEL_MAX" placeholder="예: 12기" />
              <p v-if="fieldErrors.cohortLabel" class="field-error">{{ fieldText(fieldErrors.cohortLabel) }}</p>
            </div>
            <div class="field">
              <label for="dir-work">지금 하는 일 (선택)</label>
              <input id="dir-work" v-model="form.currentWork" :maxlength="DIRECTORY_CURRENT_WORK_MAX" placeholder="예: 백엔드 개발, 대학원 진학 준비" />
              <p v-if="fieldErrors.currentWork" class="field-error">{{ fieldText(fieldErrors.currentWork) }}</p>
            </div>
            <div class="field">
              <label for="dir-interests">관심사 (선택, 쉼표로 구분)</label>
              <input id="dir-interests" v-model="form.interests" aria-describedby="dir-interests-hint" placeholder="예: AI, 창업, 등산" />
              <p id="dir-interests-hint" class="hint">{{ DIRECTORY_INTERESTS_MAX }}개까지, 하나에 {{ DIRECTORY_INTEREST_MAX }}자까지.</p>
              <p v-if="fieldErrors.interests" class="field-error">{{ fieldText(fieldErrors.interests) }}</p>
            </div>
            <div class="field">
              <label for="dir-contact">연락 방법 (선택)</label>
              <input id="dir-contact" v-model="form.contactMethod" :maxlength="DIRECTORY_CONTACT_METHOD_MAX" aria-describedby="dir-contact-warning" />
              <p id="dir-contact-warning" class="notice" data-testid="directory-contact-warning">
                주의: 여기에 적은 연락 방법은 이 방 멤버 <strong>모두</strong>에게 보입니다. 전화번호·개인 메일처럼 민감한 정보는 적지 않는 것을 권합니다.
              </p>
              <p v-if="fieldErrors.contactMethod" class="field-error">{{ fieldText(fieldErrors.contactMethod) }}</p>
            </div>
            <label>
              <input v-model="form.consent" type="checkbox" data-testid="directory-consent" />
              위 내용을 읽었고, 적은 항목을 이 방 멤버에게 보이는 데 동의합니다.
            </label>
            <p v-if="fieldErrors.consent" class="field-error">{{ fieldText(fieldErrors.consent) }}</p>
            <p class="actions">
              <button type="submit" :disabled="busy === 'save'">{{ mine ? '동의하고 바꾸기' : '동의하고 명부에 올리기' }}</button>
              <button v-if="mine" type="button" class="secondary" :disabled="busy === 'withdraw'" @click="withdraw">동의 철회(내 항목 지우기)</button>
            </p>
          </form>
          <template v-else>
            <p class="muted">보관되었거나 제한된 방이라 명부에 올리거나 바꿀 수 없습니다.</p>
            <p v-if="mine" class="actions">
              <button type="button" class="secondary" :disabled="busy === 'withdraw'" @click="withdraw">동의 철회(내 항목 지우기)</button>
            </p>
          </template>
        </section>

        <section aria-labelledby="directory-list">
          <h2 id="directory-list">명부</h2>
          <template v-if="state">
            <ul v-if="state.entries.length" class="plain hub-list" data-testid="directory-list">
              <li v-for="(e, i) in state.entries" :key="`${state.page}-${i}`" class="hub-card">
                <p>
                  <strong>{{ e.name }}</strong>
                  <span v-if="e.cohortLabel" class="badge">{{ e.cohortLabel }}</span>
                  <span v-if="e.mine" class="badge">나</span>
                </p>
                <p v-if="e.currentWork" class="small">{{ e.currentWork }}</p>
                <p v-if="e.interests.length" class="small">관심사: {{ e.interests.join(', ') }}</p>
                <p v-if="e.contactMethod" class="small">연락: {{ e.contactMethod }}</p>
              </li>
            </ul>
            <p v-else class="muted">{{ state.page > 1 ? '이 쪽에는 항목이 없습니다.' : '아직 명부에 동의한 멤버가 없습니다.' }}</p>
            <nav class="actions" aria-label="명부 쪽">
              <button type="button" class="secondary" :disabled="state.page <= 1 || !!busy" @click="goTo(state.page - 1)">이전 쪽</button>
              <span class="small">{{ state.page }}쪽</span>
              <button type="button" class="secondary" :disabled="!state.hasNext || !!busy" @click="goTo(state.page + 1)">다음 쪽</button>
            </nav>
          </template>
          <p v-else class="muted">잠시 뒤 다시 보세요.</p>
        </section>
      </template>
    </template>
  </div>
</template>
