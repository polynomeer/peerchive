<script setup lang="ts">
/**
 * 제한 공유 링크 관리(E-07, ADR 0051). 포트폴리오 화면의 "포트폴리오 판" 아래에서 지금 판의 링크를 만들고, 내 링크 목록(상태·열람 횟수)을
 * 보고 철회·지웁니다.
 * - 원문 토큰은 만든 직후 한 번만 보여 줍니다(서버는 해시만 저장). 다시 볼 수 없으므로 잃어버리면 철회하고 새로 만듭니다.
 * - 열람은 횟수만 셉니다(누가·언제 봤는지는 없음).
 */
import type { CreatedShareLinkDto, ShareLinkDto, ShareLinkStatus } from '~~/shared/types/api'

const props = defineProps<{
  /** 링크를 만들 지금 판(없으면 만들기 숨김). */
  editionId: string | null
  editionVersion: number | null
}>()

const STATUS_LABELS: Record<ShareLinkStatus, string> = {
  active: '열림',
  revoked: '철회됨',
  expired: '만료됨',
  superseded: '지난 판(열 수 없음)',
}
const SHARE_ERROR_MESSAGES: Record<string, string> = {
  edition_superseded: '지금 판에만 링크를 만들 수 있습니다.',
  limit_reached: '열린 링크가 너무 많습니다. 쓰지 않는 링크를 철회하세요.',
  share_link_active: '열린 링크는 먼저 철회해야 지울 수 있습니다.',
}

const links = ref<ShareLinkDto[] | null>(null)
const failed = ref(false)
const busy = ref(false)
const label = ref('')
const days = ref(30)
const created = ref<CreatedShareLinkDto | null>(null)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function load() {
  failed.value = false
  try {
    links.value = await $fetch<ShareLinkDto[]>('/api/v1/me/share-links')
  } catch {
    failed.value = true
  }
}
onMounted(load)

const errorText = (error: unknown) => {
  const e = apiError(error)
  if (e.status === 422) return fieldText(Object.values(e.fields)[0]) ?? '입력을 확인하세요.'
  return SHARE_ERROR_MESSAGES[e.code] ?? portfolioErrorMessage(e.code)
}

async function run(action: () => Promise<void>) {
  busy.value = true
  message.value = null
  try {
    await action()
  } catch (error) {
    message.value = { kind: 'error', text: errorText(error) }
  } finally {
    busy.value = false
    await load()
  }
}

const create = () =>
  run(async () => {
    if (!props.editionId) return
    created.value = await $fetch<CreatedShareLinkDto>(`/api/v1/portfolio-editions/${props.editionId}/share-links`, {
      method: 'POST',
      body: { label: label.value || null, expiresInDays: Number(days.value) },
    })
    label.value = ''
    message.value = { kind: 'ok', text: '공유 링크를 만들었습니다. 이 주소는 지금만 볼 수 있습니다.' }
  })

const revoke = (link: ShareLinkDto) =>
  run(async () => {
    await $fetch(`/api/v1/me/share-links/${link.id}/revoke`, { method: 'POST' })
    if (created.value?.id === link.id) created.value = null
    message.value = { kind: 'ok', text: '링크를 철회했습니다. 다음 요청부터 열리지 않습니다.' }
  })

const remove = (link: ShareLinkDto) =>
  run(async () => {
    await $fetch(`/api/v1/me/share-links/${link.id}`, { method: 'DELETE' })
    message.value = { kind: 'ok', text: '링크를 목록에서 지웠습니다.' }
  })

const origin = useRequestURL().origin
const createdUrl = computed(() => (created.value ? `${origin}${created.value.path}` : ''))
</script>

<template>
  <div class="stack" data-testid="share-links">
    <h3>제한 공유 링크</h3>
    <p class="hint">
      지금 판을 링크를 받은 사람만 보게 합니다(검색엔진 제외). 판의 공개 사례만 보이고 공개 프로필보다 좁습니다. 만료(최대 90일)·철회할 수 있고,
      열람은 횟수만 셉니다. 새 판을 만들면 이전 판의 링크는 열리지 않습니다.
    </p>
    <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>
    <p v-if="failed" class="notice error" role="alert">공유 링크 목록을 불러오지 못했습니다.</p>

    <form v-if="editionId" class="stack" @submit.prevent="create">
      <div class="field">
        <label for="share-label">이름(선택, 나만 봄)</label>
        <input id="share-label" v-model="label" maxlength="60" placeholder="예: OO회사 지원" />
      </div>
      <div class="field">
        <label for="share-days">만료(일)</label>
        <input id="share-days" v-model.number="days" type="number" min="1" max="90" />
      </div>
      <p class="actions">
        <button type="submit" :disabled="busy">판 v{{ editionVersion }} 공유 링크 만들기</button>
      </p>
    </form>
    <p v-else class="muted small">판을 만들면 공유 링크를 만들 수 있습니다.</p>

    <div v-if="created" class="notice" data-testid="created-share-link">
      <p class="small">새 링크(다시 볼 수 없으니 지금 복사하세요):</p>
      <p><input :value="createdUrl" readonly aria-label="새 공유 링크 주소" class="share-url" @focus="($event.target as HTMLInputElement).select()" /></p>
    </div>

    <ul v-if="links && links.length" class="plain hub-list" aria-label="내 공유 링크">
      <li v-for="link in links" :key="link.id" class="hub-card" :data-share-link-id="link.id">
        <p class="small">
          <strong>{{ link.label ?? '이름 없는 링크' }}</strong>
          · <span class="badge">{{ STATUS_LABELS[link.status] }}</span>
          · {{ link.edition.personaKind === 'real' ? '실명' : '표시명' }} 판 v{{ link.edition.version }}
          · 열람 {{ link.viewCount }}회
          · {{ formatDateTime(link.expiresAt) }} 만료
        </p>
        <p class="actions">
          <button v-if="link.status === 'active'" type="button" class="secondary" :disabled="busy" @click="revoke(link)">철회</button>
          <button v-else type="button" class="link-button" :disabled="busy" @click="remove(link)">목록에서 지우기</button>
        </p>
      </li>
    </ul>
    <p v-else-if="links" class="muted small">아직 만든 공유 링크가 없습니다.</p>
  </div>
</template>

<style scoped>
.share-url {
  width: 100%;
}
</style>
