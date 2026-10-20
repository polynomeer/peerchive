<script setup lang="ts">
import type { AssignableRole, InvitationDto, MemberDto, ProjectDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const id = computed(() => String(route.params.id))
const { me } = useAuth()

const { data: project, error: projectError, refresh: refreshProject } = await useFetch<ProjectDto>(
  () => `/api/v1/projects/${id.value}`,
)
const { data: members, refresh: refreshMembers } = await useFetch<MemberDto[]>(
  () => `/api/v1/projects/${id.value}/members`,
  { default: () => [] },
)
const isOwner = computed(() => project.value?.myRole === 'owner')
const canEdit = computed(() => project.value?.myRole === 'owner' || project.value?.myRole === 'editor')

const { data: invitations, refresh: refreshInvitations } = await useFetch<InvitationDto[]>(
  () => `/api/v1/projects/${id.value}/invitations`,
  { default: () => [], immediate: isOwner.value, watch: false },
)

useHead({ title: () => (project.value ? `${project.value.title} — Peerchive` : '과제 — Peerchive') })

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const say = (kind: 'ok' | 'error', text: string) => (notice.value = { kind, text })

async function reloadAll() {
  await Promise.all([refreshProject(), refreshMembers(), isOwner.value ? refreshInvitations() : Promise.resolve()])
}

// ── 기본 정보 수정 (낙관적 동시성) ──
const editing = ref(false)
const edit = reactive({ title: '', goal: '', summaryByStudent: '' })
const editErrors = ref<Record<string, string>>({})
function startEdit() {
  if (!project.value) return
  edit.title = project.value.title
  edit.goal = project.value.goal ?? ''
  edit.summaryByStudent = project.value.summaryByStudent ?? ''
  editErrors.value = {}
  editing.value = true
}
async function saveEdit() {
  if (!project.value) return
  editErrors.value = {}
  try {
    project.value = await $fetch<ProjectDto>(`/api/v1/projects/${id.value}`, {
      method: 'PATCH',
      body: { ...edit, expectedVersion: project.value.version },
    })
    editing.value = false
    say('ok', '저장했습니다.')
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) editErrors.value = err.fields
    else if (err.status === 409)
      say('error', '다른 멤버가 먼저 수정했습니다. 입력한 내용은 남겨 두었으니 최신 내용을 확인한 뒤 다시 저장하세요.')
    else say('error', '저장하지 못했습니다. 다시 시도하세요.')
    if (err.status === 409) await refreshProject()
  }
}

// ── 사후 작성 모드 (T-07) ──
// 켜고 끄는 것은 owner만. 이미 만든 로그·마일스톤의 ‘사후 작성’ 표시는 모드를 꺼도 남습니다.
const retro = computed(() => project.value?.retrospective ?? false)
async function toggleRetro() {
  if (!project.value) return
  const next = !project.value.retroMode
  const question = next
    ? '사후 작성 모드를 켤까요? 지금부터 쓰는 로그·마일스톤·스냅샷에 ‘사후 작성’이 표시됩니다.'
    : '사후 작성 모드를 끌까요? 이미 쓴 항목의 ‘사후 작성’ 표시는 그대로 남고, 지금부터 쓰는 기록만 진행 중 기록이 됩니다.'
  if (!confirm(question)) return
  try {
    project.value = await $fetch<ProjectDto>(`/api/v1/projects/${id.value}`, {
      method: 'PATCH',
      body: { expectedVersion: project.value.version, retroMode: next },
    })
    say('ok', next ? '사후 작성 모드를 켰습니다.' : '사후 작성 모드를 껐습니다.')
  } catch (e) {
    const err = apiError(e)
    say('error', err.status === 409 ? '다른 멤버가 먼저 수정했습니다. 최신 내용을 불러왔으니 다시 시도하세요.' : '모드를 바꾸지 못했습니다.')
    await refreshProject()
  }
}

// 사후 작성 안내(닫으면 이 기기에서 프로젝트별로 기억, 다시 열 수 있음).
const guideKey = computed(() => `peerchive:retro-guide-hidden:${id.value}`)
const guideHidden = ref(false)
onMounted(() => {
  try {
    guideHidden.value = localStorage.getItem(guideKey.value) === '1'
  } catch {
    guideHidden.value = false
  }
})
function setGuideHidden(hidden: boolean) {
  guideHidden.value = hidden
  try {
    if (hidden) localStorage.setItem(guideKey.value, '1')
    else localStorage.removeItem(guideKey.value)
  } catch {
    // 저장할 수 없으면 이번 화면에서만 닫습니다.
  }
}

// ── 초대 ──
const inviteRole = ref<AssignableRole>('editor')
const inviteUrl = ref<string | null>(null)
const copied = ref(false)
async function createInvite() {
  inviteUrl.value = null
  copied.value = false
  try {
    const res = await $fetch<{ inviteUrl: string }>(`/api/v1/projects/${id.value}/invitations`, {
      method: 'POST',
      body: { role: inviteRole.value },
    })
    inviteUrl.value = res.inviteUrl
    await refreshInvitations()
  } catch {
    say('error', '초대 링크를 만들지 못했습니다.')
  }
}
async function copyInvite() {
  if (!inviteUrl.value) return
  try {
    await navigator.clipboard.writeText(inviteUrl.value)
    copied.value = true
  } catch {
    copied.value = false
    say('error', '복사하지 못했습니다. 링크를 직접 선택해 복사하세요.')
  }
}
async function revokeInvite(invitationId: string) {
  try {
    await $fetch(`/api/v1/projects/${id.value}/invitations/${invitationId}`, { method: 'DELETE' })
    await refreshInvitations()
    say('ok', '초대를 취소했습니다.')
  } catch {
    say('error', '초대를 취소하지 못했습니다.')
  }
}

// ── 멤버 관리 ──
async function changeRole(member: MemberDto, role: string) {
  try {
    members.value = await $fetch<MemberDto[]>(`/api/v1/projects/${id.value}/members/${member.userId}`, {
      method: 'PATCH',
      body: { role },
    })
    say('ok', `${member.displayName || '멤버'}의 역할을 바꿨습니다.`)
  } catch {
    say('error', '역할을 바꾸지 못했습니다.')
    await refreshMembers()
  }
}
async function removeMember(member: MemberDto) {
  if (!confirm(`${member.displayName || '이 멤버'}를 과제에서 내보낼까요?`)) return
  try {
    await $fetch(`/api/v1/projects/${id.value}/members/${member.userId}`, { method: 'DELETE' })
    await refreshMembers()
    say('ok', '멤버를 내보냈습니다.')
  } catch {
    say('error', '멤버를 내보내지 못했습니다.')
  }
}

const transferTo = ref('')
const transferCandidates = computed(() => members.value.filter((m) => m.userId !== me.value?.id))
async function transfer() {
  const target = transferCandidates.value.find((m) => m.userId === transferTo.value)
  if (!target) return
  if (!confirm(`${target.displayName || '선택한 멤버'}에게 운영 책임자(owner)를 넘길까요? 나는 편집자(editor)가 됩니다.`)) return
  try {
    await $fetch(`/api/v1/projects/${id.value}/transfer-ownership`, { method: 'POST', body: { userId: target.userId } })
    transferTo.value = ''
    await reloadAll()
    say('ok', '소유권을 넘겼습니다.')
  } catch {
    say('error', '소유권을 넘기지 못했습니다.')
  }
}

async function leave() {
  if (!confirm('이 과제에서 나갈까요? 다시 참여하려면 새 초대가 필요합니다.')) return
  try {
    await $fetch(`/api/v1/projects/${id.value}/leave`, { method: 'POST' })
    await navigateTo('/projects')
  } catch (e) {
    say('error', apiError(e).code === 'owner_must_transfer' ? '먼저 다른 멤버에게 소유권을 넘기세요.' : '나가지 못했습니다.')
  }
}

const STATUS_LABELS: Record<InvitationDto['status'], string> = {
  pending: '대기',
  used: '수락됨',
  expired: '만료',
  revoked: '취소됨',
}
const formatDate = (iso: string) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div>
    <template v-if="projectError || !project">
      <h1>과제를 찾을 수 없습니다</h1>
      <p>없는 과제이거나 볼 수 있는 권한이 없습니다.</p>
      <NuxtLink to="/projects">내 과제로 돌아가기</NuxtLink>
    </template>

    <template v-else>
      <p><NuxtLink to="/projects">← 내 과제</NuxtLink></p>
      <h1>{{ project.title }}</h1>
      <p class="actions">
        <span class="badge private">🔒 팀만 보기</span>
        <span v-if="retro" class="badge retro">사후 작성</span>
        <span class="muted">{{ project.kind === 'team' ? '팀 과제' : '개인 과제' }} · 내 역할: {{ ROLE_LABELS[project.myRole] }}</span>
      </p>

      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">
        {{ notice.text }}
      </p>

      <RetroGuide v-if="retro && !guideHidden" @dismiss="setGuideHidden(true)" />
      <p v-else-if="retro" class="hint">
        <button type="button" class="link-button" @click="setGuideHidden(false)">사후 작성 안내 다시 보기</button>
      </p>

      <section class="card" aria-labelledby="overview-heading">
        <h2 id="overview-heading">개요</h2>
        <template v-if="!editing">
          <dl>
            <dt>목표</dt>
            <dd>{{ project.goal || '아직 없음' }}</dd>
            <dt>요약</dt>
            <dd>{{ project.summaryByStudent || '아직 없음' }}</dd>
          </dl>
          <div class="actions">
            <button v-if="canEdit" type="button" class="secondary" @click="startEdit">수정</button>
            <button v-if="isOwner" type="button" class="secondary" @click="toggleRetro">
              {{ project.retroMode ? '사후 작성 모드 끄기' : '사후 작성 모드 켜기' }}
            </button>
          </div>
          <p class="hint">
            사후 작성 모드: {{ project.retroMode ? '켜짐 — 지금 쓰는 기록에 ‘사후 작성’이 표시됩니다.' : '꺼짐 — 진행 중 기록으로 남습니다.' }}
            <template v-if="!isOwner"> 모드는 운영 책임자만 바꿀 수 있습니다.</template>
          </p>
        </template>
        <form v-else class="stack" novalidate @submit.prevent="saveEdit">
          <div class="field">
            <label for="edit-title">과제 이름</label>
            <input id="edit-title" v-model="edit.title" :aria-invalid="editErrors.title ? 'true' : undefined" />
            <p v-if="editErrors.title" class="field-error">{{ fieldMessage(editErrors.title) }}</p>
          </div>
          <div class="field">
            <label for="edit-goal">목표</label>
            <textarea id="edit-goal" v-model="edit.goal" />
            <p v-if="editErrors.goal" class="field-error">{{ fieldMessage(editErrors.goal) }}</p>
          </div>
          <div class="field">
            <label for="edit-summary">요약</label>
            <textarea id="edit-summary" v-model="edit.summaryByStudent" />
            <p v-if="editErrors.summaryByStudent" class="field-error">{{ fieldMessage(editErrors.summaryByStudent) }}</p>
          </div>
          <div class="actions">
            <button type="submit">저장</button>
            <button type="button" class="secondary" @click="editing = false">취소</button>
          </div>
        </form>
      </section>

      <TasksSection :project-id="project.id" :can-write="canEdit" :members="members" :retro="retro" />

      <ArtifactsSection :project-id="project.id" :can-write="canEdit" />

      <MilestonesSection :project-id="project.id" :can-write="canEdit" :retro="retro" />

      <BuildLog :project-id="project.id" :can-write="canEdit" :members="members" :me-id="me?.id ?? null" :retro="retro" />

      <section class="card" aria-labelledby="members-heading">
        <h2 id="members-heading">멤버</h2>
        <ul class="plain">
          <li v-for="m in members" :key="m.userId" class="row">
            <span>
              <NuxtLink v-if="m.handle" :to="`/u/${m.handle}`">{{ m.displayName || m.handle }}</NuxtLink>
              <span v-else>{{ m.displayName || '이름 미설정' }}</span>
              <span v-if="m.userId === me?.id" class="muted"> (나)</span>
            </span>
            <span class="actions">
              <template v-if="isOwner && m.role !== 'owner'">
                <label :for="`role-${m.userId}`" class="muted">역할</label>
                <select :id="`role-${m.userId}`" :value="m.role" @change="changeRole(m, ($event.target as HTMLSelectElement).value)">
                  <option v-for="r in ASSIGNABLE_ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
                </select>
                <button type="button" class="danger" @click="removeMember(m)">내보내기</button>
              </template>
              <span v-else class="muted">{{ ROLE_LABELS[m.role] }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="isOwner" class="card" aria-labelledby="invite-heading">
        <h2 id="invite-heading">멤버 초대</h2>
        <p class="hint">초대 링크는 7일 동안 한 번만 쓸 수 있습니다. 링크는 지금 한 번만 표시되니 바로 전달하세요.</p>
        <form class="actions" @submit.prevent="createInvite">
          <label for="invite-role">역할</label>
          <select id="invite-role" v-model="inviteRole">
            <option v-for="r in ASSIGNABLE_ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
          </select>
          <button type="submit">초대 링크 만들기</button>
        </form>
        <div v-if="inviteUrl" class="stack" style="margin-top: 1rem">
          <label for="invite-url">초대 링크 (한 번만 표시)</label>
          <div class="copy-box">
            <input id="invite-url" :value="inviteUrl" readonly @focus="($event.target as HTMLInputElement).select()" />
            <button type="button" @click="copyInvite">복사</button>
          </div>
          <p role="status" class="hint">{{ copied ? '복사했습니다.' : '' }}</p>
        </div>

        <h3>초대 내역</h3>
        <p v-if="invitations.length === 0" class="muted">아직 초대가 없습니다.</p>
        <ul v-else class="plain">
          <li v-for="inv in invitations" :key="inv.id" class="row">
            <span>{{ ROLE_LABELS[inv.role] }} · {{ STATUS_LABELS[inv.status] }} <span class="muted">· 만료 {{ formatDate(inv.expiresAt) }}</span></span>
            <button v-if="inv.status === 'pending'" type="button" class="danger" @click="revokeInvite(inv.id)">취소</button>
          </li>
        </ul>
      </section>

      <section class="card" aria-labelledby="leave-heading">
        <h2 id="leave-heading">{{ isOwner ? '소유권 이전' : '과제 나가기' }}</h2>
        <form v-if="isOwner" class="stack" @submit.prevent="transfer">
          <p class="hint">운영 책임자는 바로 나갈 수 없습니다. 다른 멤버에게 소유권을 넘기면 편집자가 되고, 그 뒤에 나갈 수 있습니다.</p>
          <p v-if="transferCandidates.length === 0" class="muted">넘길 수 있는 멤버가 없습니다. 먼저 멤버를 초대하세요.</p>
          <div v-else class="actions">
            <label for="transfer-to">받을 멤버</label>
            <select id="transfer-to" v-model="transferTo">
              <option value="" disabled>선택하세요</option>
              <option v-for="m in transferCandidates" :key="m.userId" :value="m.userId">{{ m.displayName || m.handle || '이름 미설정' }}</option>
            </select>
            <button type="submit" class="danger" :disabled="!transferTo">소유권 넘기기</button>
          </div>
        </form>
        <div v-else class="actions">
          <button type="button" class="danger" @click="leave">이 과제에서 나가기</button>
        </div>
      </section>
    </template>
  </div>
</template>
