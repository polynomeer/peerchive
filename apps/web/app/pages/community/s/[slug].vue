<script setup lang="ts">
/**
 * 커뮤니티 공간 화면(C-02, PROOFU_EVOLUTION_PLAN §8.9.2–§8.9.4, ADR 0019). 로그인 전용·noindex.
 * - 읽을 수 없는 공간은 "찾을 수 없습니다"(HTTP 404, 존재를 숨김). 멤버가 아니어도 들어갈 수 있는 방이면 소개와 가입 버튼만 보입니다.
 * - 게시판 목록(누르면 글 목록·글쓰기, C-04), 이 공간의 이름 표시 방식, 나가기.
 * - 방장·운영진: 설정, 게시판 더하기, 멤버(승인·거절·역할·내보내기), 초대 링크(7일·한 번만), 보관.
 * - 이름 표시 방식(C-03): 예약된 변경이 있으면 모두에게 배너("N일 뒤 … 바뀝니다. 이미 쓴 글은 바뀌지 않습니다."), 멤버에게 변경 이력,
 *   방장에게 예약·취소(7일 뒤 적용, 멤버 전원에게 알림).
 * - 방 운영(C-06, 방장·admin·moderator): 방 운영진이 가린 글·댓글, 제재 요청과 상태(제재가 있었는지만), 이 방 범위 쓰기 제한 개수.
 *   누구에게 무엇이 내려졌는지는 보이지 않습니다.
 * - 동문회·OB 방(A-01, ADR 0038): 멤버에게 방별 프로필 화면 링크(P2 alumni 플래그가 꺼져 있으면 서버가 template을 general로 보내 링크가 없음).
 *   A-02(ADR 0039): 멤버에게 모임 화면(일정·투표·앨범) 링크.
 *   A-03(ADR 0040): 익명 방이 아니면 멤버에게 멤버 명부(동의한 멤버만) 링크.
 * - 스터디 방(C-08): "게시판"·"기록" 탭. 기록 탭은 스터디 기록(빌드 로그·마일스톤·할 일·파일, StudyRecordSection).
 */
import type {
  BoardKind,
  JoinResultDto,
  NameMode,
  NameModeStateDto,
  SpaceDetailDto,
  SpaceInvitationDto,
  SpaceMemberDto,
  SpaceMembersDto,
  SpaceModerationDto,
  SpaceRole,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
// 제목·robots·referrer는 공통(C-05): 공간 이름으로 제목·OG를 만들지 않습니다. 헤더는 서버 미들웨어가 붙입니다.
useCommunityPage()

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const { me } = useAuth()
const fetcher = useRequestFetch()
const { data: space, error, refresh } = await useAsyncData(`space-${slug.value}`, () => fetcher<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}`))
const missing = computed(() => !!error.value || !space.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
function fail(e: unknown) {
  const err = apiError(e)
  notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
}

const isMember = computed(() => space.value?.access === 'member')
// 스터디 방의 탭(C-08). 주소의 #record로 기록 탭을 바로 엽니다.
const tab = ref<'boards' | 'record'>('boards')
const isStudyRoom = computed(() => space.value?.kind === 'study_room')
onMounted(() => {
  if (window.location.hash === '#record') tab.value = 'record'
})
function selectTab(next: 'boards' | 'record') {
  tab.value = next
  history.replaceState(history.state, '', next === 'record' ? '#record' : window.location.pathname + window.location.search)
}
const perms = computed(() => space.value?.permissions)
const isManager = computed(() => !!perms.value && (perms.value.reviewRequests || perms.value.removeMembers))

// ── 방 운영(C-06) ──
const moderation = ref<SpaceModerationDto | null>(null)
async function loadModeration() {
  if (!perms.value?.moderate) return
  try {
    moderation.value = await $fetch<SpaceModerationDto>(`/api/v1/community/spaces/${slug.value}/moderation`)
  } catch {
    moderation.value = null
  }
}
onMounted(loadModeration)
const REQUEST_STATUS_TEXT: Record<SpaceModerationDto['requests'][number]['status'], string> = { received: '접수됨', resolved: '처리됨', dismissed: '기각됨' }

// ── 가입·나가기 ──
async function join() {
  busy.value = 'join'
  notice.value = null
  try {
    const res = await $fetch<JoinResultDto>(`/api/v1/community/spaces/${slug.value}/join`, { method: 'POST' })
    notice.value = { kind: 'ok', text: res.status === 'active' ? '들어왔습니다.' : '가입을 요청했습니다. 방장의 승인을 기다리세요.' }
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function leave() {
  const owner = space.value?.myMembership?.role === 'owner'
  const question = owner
    ? '방장이 나가면 가장 오래된 운영진(없으면 가장 오래된 멤버)에게 방장이 넘어갑니다. 남은 멤버가 없으면 방이 보관됩니다. 나갈까요?'
    : space.value?.myMembership?.status === 'pending'
      ? '가입 요청을 취소할까요?'
      : '이 방에서 나갈까요?'
  if (!window.confirm(question)) return
  busy.value = 'leave'
  try {
    const res = await $fetch<{ succession: 'transferred' | 'archived' | null }>(`/api/v1/community/spaces/${slug.value}/leave`, { method: 'POST' })
    await navigateTo({ path: '/community', query: res.succession ? { left: res.succession } : {} })
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

// ── 설정 ──
const settings = reactive({ name: '', description: '', discovery: 'listed', joinPolicy: 'open' })
watch(
  space,
  (s) => {
    if (!s) return
    settings.name = s.name
    settings.description = s.description ?? ''
    settings.discovery = s.discovery
    settings.joinPolicy = s.joinPolicy
  },
  { immediate: true },
)
const settingsErrors = ref<Record<string, string>>({})
async function saveSettings() {
  if (!space.value) return
  busy.value = 'settings'
  notice.value = null
  settingsErrors.value = {}
  try {
    const body: Record<string, unknown> = { name: settings.name, description: settings.description || null }
    if (!space.value.official) Object.assign(body, { discovery: settings.discovery, joinPolicy: settings.joinPolicy })
    space.value = await $fetch<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}`, { method: 'PATCH', body })
    notice.value = { kind: 'ok', text: '설정을 저장했습니다.' }
  } catch (e) {
    settingsErrors.value = apiError(e).fields
    fail(e)
  } finally {
    busy.value = null
  }
}
async function archive() {
  if (!window.confirm('방을 보관할까요? 보관하면 멤버는 읽기만 하고 가입·쓰기·설정 변경이 멈춥니다. 되돌릴 수 없습니다.')) return
  busy.value = 'archive'
  try {
    space.value = await $fetch<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}/archive`, { method: 'POST' })
    notice.value = { kind: 'ok', text: '방을 보관했습니다.' }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

// ── 게시판 ──
const newBoard = reactive({ kind: 'general' as BoardKind, title: '' })
async function addBoard() {
  busy.value = 'board'
  notice.value = null
  try {
    await $fetch(`/api/v1/community/spaces/${slug.value}/boards`, { method: 'POST', body: { kind: newBoard.kind, title: newBoard.title } })
    newBoard.title = ''
    notice.value = { kind: 'ok', text: '게시판을 더했습니다.' }
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

// ── 멤버 ──
const members = ref<SpaceMembersDto | null>(null)
async function loadMembers() {
  if (!isManager.value) return
  try {
    members.value = await $fetch<SpaceMembersDto>(`/api/v1/community/spaces/${slug.value}/members`)
  } catch (e) {
    fail(e)
  }
}
const invitations = ref<SpaceInvitationDto[]>([])
const inviteUrl = ref('')
async function loadInvitations() {
  if (!perms.value?.invite) return
  try {
    invitations.value = await $fetch<SpaceInvitationDto[]>(`/api/v1/community/spaces/${slug.value}/invitations`)
  } catch {
    invitations.value = []
  }
}
// ── 이름 표시 방식(C-03) ──
const nameModes = ref<NameModeStateDto | null>(null)
const nextMode = ref<NameMode | ''>('')
async function loadNameModes() {
  if (!isMember.value || space.value?.official) return
  try {
    nameModes.value = await $fetch<NameModeStateDto>(`/api/v1/community/spaces/${slug.value}/name-mode-changes`)
  } catch {
    nameModes.value = null
  }
}
const nowMs = ref(Date.now())
const banner = computed(() => {
  const p = space.value?.pendingNameModeChange
  return p ? nameModeBannerText(p.toMode, new Date(p.effectiveAt), new Date(nowMs.value)) : null
})
const modeChoices = computed(() => (['real', 'display', 'anonymous'] as const).filter((m) => m !== space.value?.nameMode))
async function scheduleMode() {
  if (!nextMode.value) {
    notice.value = { kind: 'error', text: '바꿀 이름 표시 방식을 고르세요.' }
    return
  }
  const to = NAME_MODE_LABELS[nextMode.value]
  const extra = nextMode.value === 'real' && space.value?.joinPolicy === 'open' ? ' 실명 방이 되므로 가입 방식이 지금 방장 승인으로 바뀝니다.' : ''
  if (!window.confirm(`7일 뒤 이름 표시 방식을 ${to}으로 바꿀까요? 멤버 모두에게 알림이 가고, 이미 쓴 글은 바뀌지 않습니다.${extra}`)) return
  busy.value = 'name-mode'
  notice.value = null
  try {
    nameModes.value = await $fetch<NameModeStateDto>(`/api/v1/community/spaces/${slug.value}/name-mode-changes`, { method: 'POST', body: { toMode: nextMode.value } })
    nextMode.value = ''
    notice.value = { kind: 'ok', text: `이름 표시 방식 변경을 예약했습니다(7일 뒤 ${to}). 멤버 모두에게 알렸습니다.` }
    nowMs.value = Date.now()
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function cancelMode(id: string) {
  if (!window.confirm('이름 표시 방식 변경 예약을 취소할까요? 멤버 모두에게 알림이 갑니다.')) return
  busy.value = 'name-mode'
  notice.value = null
  try {
    nameModes.value = await $fetch<NameModeStateDto>(`/api/v1/community/spaces/${slug.value}/name-mode-changes/${id}`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: '예약을 취소했습니다. 지금 방식이 그대로 유지됩니다.' }
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

onMounted(() => {
  nowMs.value = Date.now()
  void loadMembers()
  void loadInvitations()
  void loadNameModes()
})

async function memberAction(m: SpaceMemberDto, action: 'approve' | 'reject' | 'remove') {
  if (action === 'remove' && !window.confirm(`${m.displayName}님을 내보낼까요? 새 초대로만 다시 들어올 수 있습니다.`)) return
  busy.value = m.userId
  notice.value = null
  try {
    members.value =
      action === 'remove'
        ? await $fetch<SpaceMembersDto>(`/api/v1/community/spaces/${slug.value}/members/${m.userId}`, { method: 'DELETE' })
        : await $fetch<SpaceMembersDto>(`/api/v1/community/spaces/${slug.value}/members/${m.userId}/${action}`, { method: 'POST' })
    notice.value = { kind: 'ok', text: action === 'approve' ? `${m.displayName}님을 승인했습니다.` : action === 'reject' ? '요청을 거절했습니다.' : '내보냈습니다.' }
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function changeRole(m: SpaceMemberDto, role: SpaceRole) {
  if (role === m.role) return
  if (role === 'owner' && !window.confirm(`${m.displayName}님에게 방장을 넘길까요? 나는 운영진이 됩니다.`)) return
  busy.value = m.userId
  notice.value = null
  try {
    members.value = await $fetch<SpaceMembersDto>(`/api/v1/community/spaces/${slug.value}/members/${m.userId}`, { method: 'PATCH', body: { role } })
    notice.value = { kind: 'ok', text: '역할을 바꿨습니다.' }
    await refresh()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

async function createInvite() {
  busy.value = 'invite'
  notice.value = null
  try {
    const res = await $fetch<{ inviteUrl: string }>(`/api/v1/community/spaces/${slug.value}/invitations`, { method: 'POST' })
    inviteUrl.value = res.inviteUrl
    notice.value = { kind: 'ok', text: '초대 링크를 만들었습니다. 이 링크는 지금만 보이며 7일 동안 한 번 쓸 수 있습니다.' }
    await loadInvitations()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}
async function revokeInvite(inv: SpaceInvitationDto) {
  busy.value = inv.id
  try {
    await $fetch(`/api/v1/community/spaces/${slug.value}/invitations/${inv.id}`, { method: 'DELETE' })
    await loadInvitations()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

const INVITE_STATUS: Record<SpaceInvitationDto['status'], string> = { pending: '사용 가능', used: '사용됨', expired: '만료됨', revoked: '취소됨' }
const roleChoices = (m: SpaceMemberDto): SpaceRole[] => (m.role === 'owner' ? ['owner'] : ['admin', 'moderator', 'member', 'owner'])
const isMe = (m: SpaceMemberDto) => m.userId === me.value?.id
</script>

<template>
  <div class="space-page">
    <template v-if="missing">
      <h1>공간을 찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 공간을 볼 수 있는 학교 인증·멤버십이 없습니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="space">
      <h1>
        {{ space.name }}
        <span v-if="space.official" class="badge">공식</span>
      </h1>
      <p class="small muted">
        {{ SPACE_KIND_LABELS[space.kind] }}
        <template v-if="space.school"> · {{ space.school.name }}</template>
        <template v-if="space.departmentLabel"> · {{ space.departmentLabel }}</template>
        <template v-if="space.memberCount !== null"> · 멤버 {{ space.memberCount }}명</template>
        <template v-if="space.template === 'alumni'"> · {{ SPACE_TEMPLATE_LABELS.alumni }} 방</template>
      </p>
      <p class="notice">이 공간의 이름 표시 방식: <strong>{{ NAME_MODE_LABELS[space.nameMode] }}</strong></p>
      <p v-if="banner" class="notice name-mode-banner" role="status">{{ banner }}</p>
      <p v-if="space.official" class="hint">‘공식’은 Peerchive가 열고 운영하는 페이지라는 뜻이며 학교가 인정했다는 뜻이 아닙니다. 이 학교 메일로 인증한 계정만 읽습니다.</p>
      <p v-if="space.description" class="pre">{{ space.description }}</p>
      <p v-if="space.status !== 'active'" class="notice error" role="status">{{ SPACE_STATUS_LABELS[space.status] }}</p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <template v-if="space.access === 'preview'">
        <p class="small muted">{{ JOIN_POLICY_LABELS[space.joinPolicy] }}</p>
        <p class="actions">
          <button v-if="space.joinAction === 'join'" type="button" :disabled="busy === 'join'" @click="join">들어가기</button>
          <button v-else-if="space.joinAction === 'request'" type="button" :disabled="busy === 'join'" @click="join">가입 요청</button>
          <template v-else-if="space.joinAction === 'pending'">
            <span>방장의 승인을 기다리는 중입니다.</span>
            <button type="button" class="secondary" :disabled="busy === 'leave'" @click="leave">요청 취소</button>
          </template>
          <span v-else>지금은 들어갈 수 없습니다(정원이 찼을 수 있습니다).</span>
        </p>
      </template>

      <template v-else>
        <div v-if="isStudyRoom" class="tabs actions" role="tablist" aria-label="스터디 방 보기">
          <button
            id="tab-boards"
            type="button"
            role="tab"
            :class="tab === 'boards' ? '' : 'secondary'"
            :aria-selected="tab === 'boards'"
            aria-controls="panel-boards"
            @click="selectTab('boards')"
          >
            게시판
          </button>
          <button
            id="tab-record"
            type="button"
            role="tab"
            :class="tab === 'record' ? '' : 'secondary'"
            :aria-selected="tab === 'record'"
            aria-controls="panel-record"
            @click="selectTab('record')"
          >
            기록
          </button>
        </div>
        <div v-if="isStudyRoom && tab === 'record'" id="panel-record" role="tabpanel" aria-labelledby="tab-record">
          <StudyRecordSection :slug="space.slug" :me-id="me?.id ?? null" />
        </div>
        <section v-show="!isStudyRoom || tab === 'boards'" id="panel-boards" :role="isStudyRoom ? 'tabpanel' : undefined" :aria-labelledby="isStudyRoom ? 'tab-boards' : 'boards'">
          <h2 id="boards">게시판</h2>
          <ul class="plain hub-list">
            <li v-for="b in space.boards" :key="b.id" class="hub-card">
              <p>
                <NuxtLink :to="`/community/b/${b.id}`"><strong>{{ b.title }}</strong></NuxtLink>
                <span v-if="b.writeRole === 'moderator'" class="badge">{{ space.official ? '모더레이터만 씀' : '운영진만 씀' }}</span>
              </p>
              <p v-if="!b.canWrite" class="small muted">이 게시판에 글을 쓸 자격이 없습니다(읽기만).</p>
              <p v-if="b.kind === 'recruiting'" class="small">
                <NuxtLink :to="`/community/recruitments?space=${space.slug}`" data-testid="recruiting-link">팀원·스터디 모집 보기·올리기</NuxtLink>
              </p>
            </li>
          </ul>
        </section>

        <p v-if="space.template === 'alumni' && space.myMembership?.status === 'active'" data-testid="gatherings-link">
          <NuxtLink :to="`/community/gatherings/${space.slug}`">모임: 일정·투표·앨범</NuxtLink>
          <span class="small muted"> — 참석 응답·투표·사진은 이 방 멤버에게만 보입니다. 운영진 공지는 ‘공지’ 게시판에서 읽음 수만 보입니다.</span>
        </p>
        <p v-if="space.template === 'alumni' && space.nameMode !== 'anonymous' && space.myMembership?.status === 'active'" data-testid="directory-link">
          <NuxtLink :to="`/community/directory/${space.slug}`">멤버 명부</NuxtLink>
          <span class="small muted"> — 동의한 멤버의 동의한 항목만, 이 방 멤버에게만 보입니다.</span>
        </p>
        <p v-if="space.template === 'alumni' && space.nameMode !== 'anonymous'" data-testid="room-profiles-link">
          <NuxtLink :to="`/community/room-profiles/${space.slug}`">방별 프로필·신분 배지</NuxtLink>
          <span class="small muted"> — 이 방 멤버에게만 보입니다.</span>
        </p>
        <p v-if="space.myMembership" class="actions">
          <button type="button" class="secondary" :disabled="busy === 'leave'" @click="leave">{{ space.myMembership.role === 'owner' ? '방장 넘기고 나가기' : '나가기' }}</button>
        </p>

        <section v-if="moderation" aria-labelledby="space-moderation" data-testid="space-moderation">
          <h2 id="space-moderation">방 운영</h2>
          <p class="hint">
            방 운영진도 익명 작성자를 볼 수 없습니다. 글·댓글 화면에서 가리거나 제재를 요청하면 운영자가 사유를 기록하고 작성자를 확인해 결정합니다.
          </p>
          <p data-testid="space-restrictions">이 방 범위 쓰기 제한: {{ moderation.activeSpaceRestrictions }}건 적용 중(누구인지는 보이지 않습니다)</p>
          <h3>운영진이 가린 글·댓글</h3>
          <ul v-if="moderation.hides.length" class="plain">
            <li v-for="h in moderation.hides" :key="h.actionId">
              <NuxtLink :to="`/community/p/${h.postId}`">{{ h.targetType === 'post' ? '글' : '댓글' }}</NuxtLink> · {{ h.publicReason }} ·
              <span class="small muted">{{ formatDateTime(h.createdAt) }}</span>
            </li>
          </ul>
          <p v-else class="small muted">없습니다.</p>
          <h3>제재 요청</h3>
          <ul v-if="moderation.requests.length" class="plain" data-testid="sanction-requests">
            <li v-for="r in moderation.requests" :key="r.id">
              <NuxtLink :to="`/community/p/${r.postId}`">{{ r.targetType === 'post' ? '글' : '댓글' }}</NuxtLink> · {{ REPORT_REASON_LABELS[r.reason] }} ·
              {{ REQUEST_STATUS_TEXT[r.status] }}<template v-if="r.outcome"> ({{ r.outcome === 'sanctioned' ? '제재가 내려졌습니다' : '제재 없음' }})</template>
              <span v-if="r.mine" class="badge">내 요청</span>
              <span class="small muted"> · {{ formatDateTime(r.createdAt) }}</span>
            </li>
          </ul>
          <p v-else class="small muted">없습니다.</p>
        </section>

        <section v-if="perms?.manage" aria-labelledby="space-settings">
          <h2 id="space-settings">설정</h2>
          <form class="stack" novalidate @submit.prevent="saveSettings">
            <div class="field">
              <label for="set-name">이름</label>
              <input id="set-name" v-model="settings.name" :maxlength="SPACE_NAME_MAX" />
              <p v-if="settingsErrors.name" class="field-error">{{ SPACE_NAME_ERRORS[settingsErrors.name] ?? fieldMessage(settingsErrors.name) }}</p>
            </div>
            <div class="field">
              <label for="set-desc">소개</label>
              <textarea id="set-desc" v-model="settings.description" rows="2" :maxlength="SPACE_DESCRIPTION_MAX" />
            </div>
            <template v-if="!space.official">
              <div class="field">
                <label for="set-join">가입 방식</label>
                <select id="set-join" v-model="settings.joinPolicy">
                  <option value="open">{{ JOIN_POLICY_LABELS.open }}</option>
                  <option value="approval">{{ JOIN_POLICY_LABELS.approval }}</option>
                  <option value="invite">{{ JOIN_POLICY_LABELS.invite }}</option>
                </select>
              </div>
              <div class="field">
                <label for="set-discovery">찾기</label>
                <select id="set-discovery" v-model="settings.discovery">
                  <option value="listed">공간 찾기에 보이기</option>
                  <option value="unlisted">링크·초대로만</option>
                </select>
              </div>
            </template>
            <p class="actions"><button type="submit" :disabled="busy === 'settings'">설정 저장</button></p>
          </form>
        </section>

        <section v-if="!space.official && nameModes" aria-labelledby="name-mode">
          <h2 id="name-mode">이름 표시 방식</h2>
          <p>지금: <strong>{{ NAME_MODE_LABELS[nameModes.currentMode] }}</strong> — {{ NAME_MODE_HINTS[nameModes.currentMode] }}</p>
          <template v-if="perms?.changeNameMode">
            <template v-if="nameModes.pending">
              <p>
                {{ formatDateTime(nameModes.pending.effectiveAt) }}에 {{ NAME_MODE_LABELS[nameModes.pending.toMode] }}으로 바뀌도록 예약되어 있습니다.
              </p>
              <p class="actions">
                <button type="button" class="secondary" :disabled="busy === 'name-mode'" @click="cancelMode(nameModes.pending.id)">변경 예약 취소</button>
              </p>
            </template>
            <form v-else class="stack" novalidate @submit.prevent="scheduleMode">
              <fieldset>
                <legend>바꿀 방식</legend>
                <div v-for="m in modeChoices" :key="m" class="field">
                  <label><input v-model="nextMode" type="radio" name="next-mode" :value="m" /> {{ NAME_MODE_LABELS[m] }}으로 바꾸기</label>
                  <p class="hint">{{ NAME_MODE_HINTS[m] }}</p>
                </div>
              </fieldset>
              <p class="hint">
                바꾸면 멤버 모두에게 바로 알림이 가고 <strong>7일 뒤</strong>부터 쓰는 글에만 적용됩니다. 이미 쓴 글·댓글은 쓸 때의 방식 그대로입니다(익명 글이 실명으로
                드러나지 않고, 실명 글도 익명이 되지 않습니다). 실명으로 바꾸면 자유 가입은 방장 승인으로 바뀝니다. 적용 전까지 취소할 수 있습니다.
              </p>
              <p class="actions"><button type="submit" :disabled="busy === 'name-mode'">변경 예약</button></p>
            </form>
          </template>
          <template v-if="nameModes.history.length">
            <h3>변경 이력</h3>
            <ul class="plain">
              <li v-for="h in nameModes.history" :key="h.id" class="small">
                {{ NAME_MODE_LABELS[h.fromMode] }} → {{ NAME_MODE_LABELS[h.toMode] }} · {{ NAME_MODE_CHANGE_STATUS_LABELS[h.status] }} · 예약
                {{ formatDateTime(h.requestedAt) }}
                <template v-if="h.status === 'applied' && h.appliedAt"> · 적용 {{ formatDateTime(h.appliedAt) }}</template>
                <template v-else-if="h.status === 'cancelled' && h.cancelledAt"> · 취소 {{ formatDateTime(h.cancelledAt) }}</template>
                <template v-else> · 적용 예정 {{ formatDateTime(h.effectiveAt) }}</template>
              </li>
            </ul>
          </template>
          <p v-else class="small muted">아직 바꾼 적이 없습니다.</p>
        </section>

        <section v-if="perms?.manageBoards && !space.official" aria-labelledby="add-board">
          <h2 id="add-board">게시판 더하기</h2>
          <form class="stack" novalidate @submit.prevent="addBoard">
            <div class="field">
              <label for="board-kind">종류</label>
              <select id="board-kind" v-model="newBoard.kind">
                <option v-for="k in ROOM_BOARD_KINDS" :key="k" :value="k">{{ BOARD_KIND_LABELS[k] }}</option>
              </select>
            </div>
            <div class="field">
              <label for="board-title">게시판 이름</label>
              <input id="board-title" v-model="newBoard.title" maxlength="30" />
              <p class="hint">공지 게시판은 운영진·모더레이터만 씁니다. 게시판은 {{ MAX_BOARDS_PER_ROOM }}개까지입니다.</p>
            </div>
            <p class="actions"><button type="submit" :disabled="busy === 'board'">게시판 더하기</button></p>
          </form>
        </section>

        <section v-if="isManager && members" aria-labelledby="members">
          <h2 id="members">멤버</h2>
          <template v-if="members.pending.length">
            <h3>가입 요청</h3>
            <ul class="plain">
              <li v-for="m in members.pending" :key="m.userId" class="row">
                <span>{{ m.displayName }}<template v-if="m.handle"> @{{ m.handle }}</template></span>
                <button type="button" :disabled="busy === m.userId" :aria-label="`${m.displayName} 승인`" @click="memberAction(m, 'approve')">승인</button>
                <button type="button" class="secondary" :disabled="busy === m.userId" :aria-label="`${m.displayName} 거절`" @click="memberAction(m, 'reject')">거절</button>
              </li>
            </ul>
          </template>
          <ul class="plain">
            <li v-for="m in members.members" :key="m.userId" class="row">
              <span>{{ m.displayName }}<template v-if="m.handle"> @{{ m.handle }}</template> · {{ SPACE_ROLE_LABELS[m.role] }}</span>
              <template v-if="!isMe(m)">
                <template v-if="perms?.changeRoles && m.role !== 'owner'">
                  <label :for="`role-${m.userId}`" class="visually-hidden">{{ m.displayName }} 역할</label>
                  <select :id="`role-${m.userId}`" :value="m.role" :disabled="busy === m.userId" @change="changeRole(m, ($event.target as HTMLSelectElement).value as SpaceRole)">
                    <option v-for="r in roleChoices(m)" :key="r" :value="r">{{ r === 'owner' ? '방장으로 넘기기' : SPACE_ROLE_LABELS[r] }}</option>
                  </select>
                </template>
                <button
                  v-if="perms?.removeMembers && m.role !== 'owner' && (perms.changeRoles || m.role === 'member' || m.role === 'moderator')"
                  type="button"
                  class="link-button"
                  :disabled="busy === m.userId"
                  :aria-label="`${m.displayName} 내보내기`"
                  @click="memberAction(m, 'remove')"
                >
                  내보내기
                </button>
              </template>
            </li>
          </ul>
        </section>

        <section v-if="perms?.invite" aria-labelledby="invites">
          <h2 id="invites">초대 링크</h2>
          <p class="hint">링크는 만든 직후에만 보입니다. 7일 동안 한 사람이 한 번 쓸 수 있고, 학교를 연결한 방은 그 학교 인증 계정만 수락할 수 있습니다.</p>
          <p class="actions"><button type="button" :disabled="busy === 'invite'" @click="createInvite">초대 링크 만들기</button></p>
          <div v-if="inviteUrl" class="field">
            <label for="invite-url">새 초대 링크</label>
            <input id="invite-url" :value="inviteUrl" readonly class="mono" @focus="($event.target as HTMLInputElement).select()" />
          </div>
          <ul v-if="invitations.length" class="plain">
            <li v-for="inv in invitations" :key="inv.id" class="row small">
              <span>{{ formatDateTime(inv.createdAt) }} · {{ INVITE_STATUS[inv.status] }}</span>
              <button v-if="inv.status === 'pending'" type="button" class="link-button" :disabled="busy === inv.id" @click="revokeInvite(inv)">취소</button>
            </li>
          </ul>
        </section>

        <section v-if="perms?.archive" aria-labelledby="archive">
          <h2 id="archive">보관</h2>
          <p class="actions"><button type="button" class="danger" :disabled="busy === 'archive'" @click="archive">방 보관하기</button></p>
        </section>
      </template>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>
