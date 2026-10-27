<script setup lang="ts">
/**
 * 스터디 방의 "기록" 탭(C-08, ADR 0026). 스터디 방이 켠 내부 과제 공간(kind study)의 할 일·마일스톤·파일·빌드 로그를 과제 화면과 같은
 * 컴포넌트로 보여 줍니다. 권한은 과제 멤버십(방 멤버십에서 파생: 방장 = 운영 책임자, 다른 멤버 = 편집자)을 그대로 따릅니다.
 * - 기록이 꺼져 있으면 방장에게만 "스터디 기록 켜기"(과목 학기 선택은 선택). 방 이름은 기록 제목에 옮기지 않습니다.
 * - 익명 방이면 다른 멤버 이름이 "스터디 멤버 N"으로 보이고, 공개는 모두 익명으로만, 포트폴리오에는 연결할 수 없다고 안내합니다.
 * - 로그는 과제 로그이며 커뮤니티 글이 아닙니다(방 글과 따로).
 */
import type { MemberDto, ProjectDetailDto, StudyRecordStateDto } from '~~/shared/types/api'

const props = defineProps<{ slug: string; meId: string | null }>()

const state = ref<StudyRecordStateDto | null>(null)
const project = ref<ProjectDetailDto | null>(null)
const members = ref<MemberDto[]>([])
const loadError = ref(false)
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const courseTermId = ref<string | null>(null)

async function load() {
  loadError.value = false
  try {
    state.value = await $fetch<StudyRecordStateDto>(`/api/v1/community/spaces/${props.slug}/study-record`)
    if (state.value.projectId) {
      const [p, m] = await Promise.all([
        $fetch<ProjectDetailDto>(`/api/v1/projects/${state.value.projectId}`),
        $fetch<MemberDto[]>(`/api/v1/projects/${state.value.projectId}/members`),
      ])
      project.value = p
      members.value = m
    }
  } catch {
    loadError.value = true
  }
}
onMounted(load)

async function enable() {
  busy.value = true
  notice.value = null
  try {
    state.value = await $fetch<StudyRecordStateDto>(`/api/v1/community/spaces/${props.slug}/study-record`, {
      method: 'POST',
      body: { courseTermId: courseTermId.value },
    })
    notice.value = { kind: 'ok', text: '스터디 기록을 켰습니다. 방 멤버 모두가 기록을 쓸 수 있습니다.' }
    await load()
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: err.status === 422 ? '과목 학기를 확인하세요.' : communityErrorMessage(err.code) }
  } finally {
    busy.value = false
  }
}

const canWrite = computed(() => project.value?.myRole === 'owner' || project.value?.myRole === 'editor')
const isOwner = computed(() => project.value?.myRole === 'owner')
const anonymous = computed(() => state.value?.nameMode === 'anonymous')
</script>

<template>
  <section aria-labelledby="study-record-heading" data-testid="study-record">
    <h2 id="study-record-heading">스터디 기록</h2>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p v-if="loadError" class="notice error" role="alert">기록을 불러오지 못했습니다.</p>
    <template v-else-if="state && !state.enabled">
      <p class="hint">
        주차별로 무엇을 했는지 빌드 로그·마일스톤으로 남기면, 끝날 때 공개 절차와 멤버 모두의 동의를 거쳐 공개 사례로 만들 수 있습니다.
        기록은 과제 공간과 같고 방 멤버가 그대로 기록 멤버가 됩니다(방장은 운영 책임자, 다른 멤버는 편집자).
      </p>
      <p v-if="anonymous" class="notice">익명 스터디 방의 기록은 다른 멤버 이름을 가리고, 공개는 모두 익명으로만 하며, 포트폴리오에 연결할 수 없습니다.</p>
      <form v-if="state.canEnable" class="stack" novalidate @submit.prevent="enable">
        <CoursePicker v-model="courseTermId" id-prefix="study-course" />
        <p class="hint">과목 학기는 선택입니다. 연결하면 그 학기가 끝날 때까지 공개가 미뤄집니다(엠바고).</p>
        <p class="actions"><button type="submit" :disabled="busy">{{ busy ? '켜는 중…' : '스터디 기록 켜기' }}</button></p>
      </form>
      <p v-else class="small muted">아직 기록이 꺼져 있습니다. 방장이 켤 수 있습니다.</p>
    </template>
    <template v-else-if="state && state.enabled && !state.projectId">
      <p class="small muted">이 방의 기록은 방 멤버만 봅니다.</p>
    </template>
    <template v-else-if="state && project">
      <p class="actions">
        <span class="badge">스터디 기록</span>
        <span class="badge private">🔒 방 멤버만 보기</span>
        <span v-if="anonymous" class="badge">익명 방</span>
        <span class="muted">내 역할: {{ ROLE_LABELS[project.myRole] }}</span>
      </p>
      <p v-if="anonymous" class="hint">
        익명 스터디 방이라 다른 멤버는 ‘스터디 멤버 N’으로 보입니다. 공개는 모두 익명으로만 할 수 있고, 이 기록은 포트폴리오·공개 프로필에 연결되지 않습니다.
      </p>
      <p class="hint">여기 쓰는 로그는 방 게시판 글이 아니라 기록(과제 로그)입니다. 공개는 공개 준비 → 멤버 모두의 동의 → 게시 순서입니다.</p>
      <p class="actions">
        <NuxtLink :to="`/projects/${project.id}`">기록 전체 화면</NuxtLink>
        <NuxtLink v-if="isOwner" :to="`/projects/${project.id}/publish`" data-testid="study-publish-link">공개 준비(후보·점검·동의)</NuxtLink>
        <NuxtLink to="/consents">내 동의 요청</NuxtLink>
      </p>
      <TasksSection :project-id="project.id" :can-write="canWrite" :members="members" :retro="project.retrospective" />
      <MilestonesSection :project-id="project.id" :can-write="canWrite" :retro="project.retrospective" />
      <ArtifactsSection :project-id="project.id" :can-write="canWrite" />
      <BuildLog :project-id="project.id" :can-write="canWrite" :members="members" :me-id="meId" :retro="project.retrospective" />
    </template>
  </section>
</template>
