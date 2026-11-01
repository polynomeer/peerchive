<script setup lang="ts">
/**
 * 커뮤니티 첫 화면(C-02, PROOFU_EVOLUTION_PLAN §8.9, ADR 0019). 로그인 전용·검색엔진 비노출(noindex).
 * - 내 공간: 내가 멤버인 방 + 내 학교 인증으로 들어가는 공식 페이지(`공식` 배지는 운영자가 연 공간에만).
 * - 찾기: 내 학교 공식 페이지와 목록에 노출된 방(학교 연결 방은 그 학교 인증 계정만).
 * - 방 만들기: 학교 인증이 하나라도 있어야 합니다. P2 alumni 플래그가 켜져 있으면 방 종류(일반·동문회·OB, A-01)를 고릅니다. 이름 표시 방식(실명·표시명·익명)은 만들 때 정하고, 방장이 7일 뒤 적용으로 바꿀 수 있습니다(C-03).
 * - 알림(C-03): 읽지 않은 수와 `/community/notices` 링크. 실명(선택): 실명 방의 글에만 보이는 이름.
 * - 공식 페이지 개설 요청: 학교 인증 계정이 요청하고, 운영자가 검토해 엽니다(요청 수는 운영자만 봄).
 */
import type {
  JoinPolicy,
  JoinResultDto,
  MySpacesDto,
  NameMode,
  OfficialPageRequestDto,
  SpaceDetailDto,
  SpaceDiscovery,
  SpaceSummaryDto,
  SpaceTemplate,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
// 제목·robots·referrer는 공통(C-05): 공간 이름으로 제목·OG를 만들지 않습니다. 헤더는 서버 미들웨어가 붙입니다.
useCommunityPage()

const { me, refresh: refreshMe } = useAuth()
// P2 기능 플래그(ADR 0037): 동문회·OB 템플릿(A-01)은 alumni가 켜져 있을 때만 고를 수 있습니다.
const { flags, ensure: ensureFeatures } = useFeatures()
await ensureFeatures()
const fetcher = useRequestFetch()
const { data: mine, refresh: refreshMine } = await useAsyncData('community-mine', () => fetcher<MySpacesDto>('/api/v1/community/spaces/mine'))
const { data: requests, refresh: refreshRequests } = await useAsyncData('community-official-requests', () =>
  fetcher<OfficialPageRequestDto[]>('/api/v1/community/official-requests'),
)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
const schools = computed(() => mine.value?.schools ?? [])

// ── 찾기 ──
const q = ref('')
const found = ref<SpaceSummaryDto[] | null>(null)
async function discover() {
  busy.value = 'discover'
  try {
    found.value = await $fetch<SpaceSummaryDto[]>('/api/v1/community/spaces/discover', { query: q.value.trim() ? { q: q.value.trim() } : {} })
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  } finally {
    busy.value = null
  }
}
onMounted(() => {
  if (schools.value.length) void discover()
})

async function join(space: SpaceSummaryDto) {
  busy.value = space.slug
  notice.value = null
  try {
    const res = await $fetch<JoinResultDto>(`/api/v1/community/spaces/${space.slug}/join`, { method: 'POST' })
    notice.value = { kind: 'ok', text: res.status === 'active' ? `${space.name}에 들어갔습니다.` : `${space.name}에 가입을 요청했습니다. 방장의 승인을 기다리세요.` }
    await Promise.all([refreshMine(), discover()])
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  } finally {
    busy.value = null
  }
}

// ── 방 만들기 ──
const room = reactive({
  name: '',
  description: '',
  schoolId: '',
  nameMode: 'display' as NameMode,
  discovery: 'listed' as SpaceDiscovery,
  joinPolicy: 'open' as JoinPolicy,
  capacity: USER_ROOM_DEFAULT_CAPACITY,
  template: 'general' as SpaceTemplate,
})
watch(
  () => room.nameMode,
  (mode) => {
    room.joinPolicy = mode === 'real' ? 'approval' : 'open'
  },
)
const roomErrors = ref<Record<string, string>>({})
async function createRoom() {
  busy.value = 'create'
  notice.value = null
  roomErrors.value = {}
  try {
    const created = await $fetch<SpaceDetailDto>('/api/v1/community/spaces', {
      method: 'POST',
      body: {
        name: room.name,
        description: room.description || null,
        schoolId: room.schoolId || null,
        nameMode: room.nameMode,
        discovery: room.discovery,
        joinPolicy: room.joinPolicy,
        capacity: Number(room.capacity),
        ...(flags.value.alumni && room.template === 'alumni' && { template: 'alumni' }),
      },
    })
    await navigateTo(`/community/s/${created.slug}`)
  } catch (e) {
    const err = apiError(e)
    roomErrors.value = err.fields
    notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
  } finally {
    busy.value = null
  }
}

// ── 공식 페이지 개설 요청 ──
const official = reactive({ schoolId: '', departmentLabel: '' })
watch(
  schools,
  (list) => {
    if (!official.schoolId && list[0]) official.schoolId = list[0].id
  },
  { immediate: true },
)
async function requestOfficial() {
  busy.value = 'official'
  notice.value = null
  try {
    const res = await $fetch<{ created: boolean }>('/api/v1/community/official-requests', {
      method: 'POST',
      body: { schoolId: official.schoolId, departmentLabel: official.departmentLabel || null },
    })
    notice.value = { kind: 'ok', text: res.created ? '개설을 요청했습니다. 운영자가 검토합니다.' : '이미 요청한 페이지입니다.' }
    official.departmentLabel = ''
    await refreshRequests()
  } catch (e) {
    notice.value = { kind: 'error', text: communityErrorMessage(apiError(e).code) }
  } finally {
    busy.value = null
  }
}

// ── 실명(선택, C-03) ──
const realName = ref(me.value?.realName ?? '')
watch(
  () => me.value?.realName,
  (v) => {
    realName.value = v ?? ''
  },
)
const realNameError = ref('')
async function saveRealName() {
  busy.value = 'real-name'
  notice.value = null
  realNameError.value = ''
  try {
    await $fetch('/api/v1/me/real-name', { method: 'PUT', body: { realName: realName.value.trim() || null } })
    await refreshMe()
    notice.value = { kind: 'ok', text: realName.value.trim() ? '실명을 저장했습니다.' : '실명을 지웠습니다.' }
  } catch (e) {
    const err = apiError(e)
    realNameError.value = err.fields.realName === 'too_long' ? `실명은 ${REAL_NAME_MAX}자까지입니다.` : '쓸 수 없는 글자가 있습니다.'
    notice.value = { kind: 'error', text: '입력한 내용을 확인하세요.' }
  } finally {
    busy.value = null
  }
}

const spaceMeta = (s: SpaceSummaryDto) =>
  [
    s.official ? SPACE_KIND_LABELS[s.kind] : s.school ? s.school.name : '학교 무관',
    `이름 표시: ${NAME_MODE_LABELS[s.nameMode]}`,
    s.official ? null : JOIN_POLICY_LABELS[s.joinPolicy],
    s.memberCount !== null ? `멤버 ${s.memberCount}명` : null,
    s.status !== 'active' ? SPACE_STATUS_LABELS[s.status] : null,
  ]
    .filter(Boolean)
    .join(' · ')
</script>

<template>
  <div class="community-page">
    <h1>커뮤니티</h1>
    <p class="hint">
      학교 인증 구성원끼리 모이는 공간입니다. 로그인한 사람에게만 보이고 검색엔진·공개 검색에 나오지 않습니다. 글쓰기는 곧 열립니다.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p>
      <NuxtLink to="/community/notices">커뮤니티 알림<template v-if="mine?.unreadNotices"> (읽지 않음 {{ mine.unreadNotices }}개)</template></NuxtLink>
      · <NuxtLink to="/community/recruitments">모집·내 지원</NuxtLink>
      <template v-if="flags.topics"> · <NuxtLink to="/community/topics" data-testid="topics-link">학교를 넘나드는 토픽</NuxtLink></template>
      <template v-if="flags.institutions"> · <NuxtLink to="/community/retros" data-testid="retros-link">수료 회고</NuxtLink></template>
    </p>

    <template v-if="!schools.length">
      <p class="notice">
        커뮤니티는 학교 메일 인증을 한 계정만 씁니다.
        <NuxtLink to="/settings/affiliations?return=/community">학교 인증하러 가기</NuxtLink>
      </p>
    </template>

    <section aria-labelledby="my-spaces">
      <h2 id="my-spaces">내 공간</h2>
      <ul v-if="mine?.items.length" class="plain hub-list">
        <li v-for="s in mine.items" :key="s.slug" class="hub-card">
          <p>
            <NuxtLink :to="`/community/s/${s.slug}`"><strong>{{ s.name }}</strong></NuxtLink>
            <span v-if="s.official" class="badge">공식</span>
            <span v-if="s.myMembership" class="badge">{{ SPACE_ROLE_LABELS[s.myMembership.role] }}</span>
          </p>
          <p class="small muted">{{ spaceMeta(s) }}</p>
        </li>
      </ul>
      <p v-else class="muted">아직 들어간 공간이 없습니다.</p>
      <template v-if="mine?.pending.length">
        <h3>승인 대기</h3>
        <ul class="plain">
          <li v-for="s in mine.pending" :key="s.slug">
            <NuxtLink :to="`/community/s/${s.slug}`">{{ s.name }}</NuxtLink> <span class="small muted">방장의 승인을 기다리는 중</span>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="schools.length" aria-labelledby="discover">
      <h2 id="discover">공간 찾기</h2>
      <form class="row" role="search" @submit.prevent="discover">
        <label for="discover-q" class="visually-hidden">공간 이름 검색</label>
        <input id="discover-q" v-model="q" type="search" maxlength="40" placeholder="방 이름" />
        <button type="submit" :disabled="busy === 'discover'">찾기</button>
      </form>
      <p class="visually-hidden" role="status">{{ found ? `공간 ${found.length}개` : '' }}</p>
      <ul v-if="found?.length" class="plain hub-list">
        <li v-for="s in found" :key="s.slug" class="hub-card">
          <p>
            <NuxtLink :to="`/community/s/${s.slug}`"><strong>{{ s.name }}</strong></NuxtLink>
            <span v-if="s.official" class="badge">공식</span>
          </p>
          <p v-if="s.description" class="small pre">{{ s.description }}</p>
          <p class="small muted">{{ spaceMeta(s) }}</p>
          <p v-if="!s.official && !s.myMembership" class="actions">
            <button type="button" :disabled="busy === s.slug" @click="join(s)">{{ s.joinPolicy === 'approval' ? '가입 요청' : '들어가기' }}</button>
          </p>
          <p v-else-if="s.myMembership?.status === 'pending'" class="small">승인 대기 중</p>
        </li>
      </ul>
      <p v-else-if="found" class="muted">찾은 공간이 없습니다.</p>
    </section>

    <section v-if="mine?.canCreateRoom" aria-labelledby="new-room">
      <h2 id="new-room">방 만들기</h2>
      <form class="stack" novalidate @submit.prevent="createRoom">
        <div class="field">
          <label for="room-name">방 이름 (필수)</label>
          <input id="room-name" v-model="room.name" :maxlength="SPACE_NAME_MAX" required aria-describedby="room-name-hint room-name-error" />
          <p id="room-name-hint" class="hint">`공식`·`학생회`·`운영자` 같은 말은 쓸 수 없습니다. `공식` 표시는 운영자가 연 페이지에만 붙습니다.</p>
          <p v-if="roomErrors.name" id="room-name-error" class="field-error">{{ SPACE_NAME_ERRORS[roomErrors.name] ?? fieldMessage(roomErrors.name) }}</p>
        </div>
        <div class="field">
          <label for="room-desc">소개 (선택)</label>
          <textarea id="room-desc" v-model="room.description" rows="2" :maxlength="SPACE_DESCRIPTION_MAX" />
        </div>
        <div class="field">
          <label for="room-school">학교</label>
          <select id="room-school" v-model="room.schoolId" aria-describedby="room-school-hint">
            <option value="">학교 무관(학교 인증 계정 누구나)</option>
            <option v-for="s in schools" :key="s.id" :value="s.id">{{ s.name }} 인증 계정만</option>
          </select>
          <p id="room-school-hint" class="hint">학교를 연결하면 그 학교 메일로 인증한 계정만 들어옵니다.</p>
        </div>
        <fieldset v-if="flags.alumni" data-testid="room-template">
          <legend>방 종류</legend>
          <div class="field">
            <label><input v-model="room.template" type="radio" name="room-template" value="general" /> {{ SPACE_TEMPLATE_LABELS.general }}</label>
          </div>
          <div class="field">
            <label><input v-model="room.template" type="radio" name="room-template" value="alumni" /> {{ SPACE_TEMPLATE_LABELS.alumni }}</label>
            <p class="hint">멤버마다 이 방에서만 쓰는 프로필(이름·현역/OB/졸업생 배지·기수·소개)을 둡니다. 방 밖·공개 프로필·검색에는 나오지 않습니다.</p>
          </div>
        </fieldset>
        <fieldset>
          <legend>이름 표시 방식</legend>
          <div v-for="mode in (['real', 'display', 'anonymous'] as const)" :key="mode" class="field">
            <label><input v-model="room.nameMode" type="radio" name="room-name-mode" :value="mode" /> {{ NAME_MODE_LABELS[mode] }}</label>
            <p class="hint">{{ NAME_MODE_HINTS[mode] }}</p>
          </div>
          <p v-if="flags.alumni && room.template === 'alumni' && room.nameMode === 'anonymous'" class="notice" role="status">
            익명은 동문 네트워킹에는 권장하지 않습니다. 익명 방에는 방별 프로필·배지가 없습니다.
          </p>
          <p class="hint">만든 뒤에는 방장이 바꿀 수 있습니다. 바꾸면 멤버에게 알리고 7일 뒤부터 쓰는 글에만 적용되며, 이전 글은 그대로입니다.</p>
        </fieldset>
        <div class="field">
          <label for="room-join">가입 방식</label>
          <select id="room-join" v-model="room.joinPolicy">
            <option value="open">{{ JOIN_POLICY_LABELS.open }}</option>
            <option value="approval">{{ JOIN_POLICY_LABELS.approval }}</option>
            <option value="invite">{{ JOIN_POLICY_LABELS.invite }}</option>
          </select>
        </div>
        <div class="field">
          <label for="room-discovery">찾기</label>
          <select id="room-discovery" v-model="room.discovery">
            <option value="listed">공간 찾기에 보이기</option>
            <option value="unlisted">링크·초대로만</option>
          </select>
        </div>
        <div class="field">
          <label for="room-capacity">정원</label>
          <input id="room-capacity" v-model.number="room.capacity" type="number" min="2" max="2000" inputmode="numeric" aria-describedby="room-capacity-hint" />
          <p id="room-capacity-hint" class="hint">기본 300명입니다. 더 큰 정원은 운영자가 검토하며, 그 전까지는 300명입니다.</p>
          <p v-if="roomErrors.capacity" class="field-error">{{ fieldMessage(roomErrors.capacity) }}</p>
        </div>
        <p class="actions"><button type="submit" :disabled="busy === 'create'">방 만들기</button></p>
      </form>
    </section>

    <section aria-labelledby="real-name">
      <h2 id="real-name">실명 (선택)</h2>
      <form class="stack" novalidate @submit.prevent="saveRealName">
        <div class="field">
          <label for="real-name-input">실명</label>
          <input id="real-name-input" v-model="realName" :maxlength="REAL_NAME_MAX" autocomplete="name" aria-describedby="real-name-hint" />
          <p id="real-name-hint" class="hint">
            이름 표시 방식이 실명인 방에서 쓴 글에만 보입니다. 공개 프로필·검색에는 나오지 않으며 Peerchive가 신분을 확인하지 않습니다. 비우고 저장하면 지웁니다.
          </p>
          <p v-if="realNameError" class="field-error">{{ realNameError }}</p>
        </div>
        <p class="actions"><button type="submit" :disabled="busy === 'real-name'">실명 저장</button></p>
      </form>
    </section>

    <section v-if="schools.length" aria-labelledby="official-request">
      <h2 id="official-request">공식 페이지 개설 요청</h2>
      <p class="hint">
        공식 학교·학과 페이지는 운영자만 엽니다. 같은 학교 인증 계정의 요청이 모이거나 학생회가 요청하면 운영자가 검토합니다. 공식 페이지는 익명으로 씁니다.
        ‘공식’은 Peerchive가 열고 운영한다는 뜻이며 학교가 인정했다는 뜻이 아닙니다.
      </p>
      <form class="stack" novalidate @submit.prevent="requestOfficial">
        <div class="field">
          <label for="official-school">요청할 학교</label>
          <select id="official-school" v-model="official.schoolId">
            <option v-for="s in schools" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>
        <div class="field">
          <label for="official-dept">학과 (선택, 비우면 학교 페이지)</label>
          <input id="official-dept" v-model="official.departmentLabel" maxlength="40" />
        </div>
        <p class="actions"><button type="submit" :disabled="busy === 'official' || !official.schoolId">개설 요청</button></p>
      </form>
      <ul v-if="requests?.length" class="plain">
        <li v-for="r in requests" :key="r.id" class="small">
          {{ r.school.name }}{{ r.departmentLabel ? ` ${r.departmentLabel}` : '' }} — 요청함 ({{ formatDateTime(r.createdAt) }})
        </li>
      </ul>
    </section>

    <p v-if="me?.operator"><NuxtLink to="/operator/community">운영: 공식 페이지·공간 관리</NuxtLink></p>
  </div>
</template>
