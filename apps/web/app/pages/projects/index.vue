<script setup lang="ts">
import type { MyCheckinStatusDto, ProjectDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '내 과제 — Peerchive' })

const { data: projects, error: loadError } = await useFetch<ProjectDto[]>('/api/v1/projects', {
  default: () => [],
})

// 대시보드 "이번 주 체크인"(T-09). 실패해도 목록은 그대로 보여 줍니다.
const { data: checkins } = await useFetch<MyCheckinStatusDto | null>('/api/v1/me/checkins', { default: () => null })
const pendingCheckins = computed(() => checkins.value?.projects.filter((p) => !p.submitted) ?? [])

const form = reactive({
  title: '',
  kind: 'individual' as 'individual' | 'team',
  retroMode: false,
  courseTermId: null as string | null,
})
const errors = ref<Record<string, string>>({})
const creating = ref(false)
const failure = ref<string | null>(null)

onMounted(() => {
  // 로그인 전에 열었던 초대 링크가 있으면 이어서 처리합니다.
  const invite = takePendingInvite()
  if (invite) navigateTo(`/invite/${invite}`)
})

async function create() {
  creating.value = true
  errors.value = {}
  failure.value = null
  try {
    const project = await $fetch<ProjectDto>('/api/v1/projects', { method: 'POST', body: form })
    await navigateTo(`/projects/${project.id}`)
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) errors.value = err.fields
    else failure.value = '과제를 만들지 못했습니다. 다시 시도하세요.'
  } finally {
    creating.value = false
  }
}

const KIND_LABELS = { individual: '개인', team: '팀', study: '스터디 기록' } as const
// 스터디 기록(C-08)은 스터디 방에서 켜고 멤버도 방에서 관리하므로 "내 과제"와 따로 묶어 보여 줍니다.
const ownProjects = computed(() => projects.value.filter((p) => p.kind !== 'study'))
const studyProjects = computed(() => projects.value.filter((p) => p.kind === 'study'))
</script>

<template>
  <div>
    <h1>내 과제</h1>

    <p v-if="loadError" class="notice error" role="alert">목록을 불러오지 못했습니다.</p>
    <p v-else-if="ownProjects.length === 0" class="muted">아직 과제가 없습니다. 아래에서 첫 과제를 만들어 보세요.</p>
    <ul v-else class="plain">
      <li v-for="p in ownProjects" :key="p.id" class="row">
        <span>
          <NuxtLink :to="`/projects/${p.id}`">{{ p.title }}</NuxtLink>
          <span class="muted"> · {{ KIND_LABELS[p.kind] }} · {{ ROLE_LABELS[p.myRole] }}</span>
        </span>
        <span class="actions">
          <span v-if="p.retrospective" class="badge retro">사후 작성</span>
          <span class="badge private">🔒 팀만 보기</span>
        </span>
      </li>
    </ul>

    <section v-if="studyProjects.length > 0" class="card" aria-labelledby="study-records-heading">
      <h2 id="study-records-heading">스터디 기록</h2>
      <p class="hint">스터디 방에서 켠 기록입니다. 멤버는 스터디 방 멤버를 따릅니다.</p>
      <ul class="plain">
        <li v-for="p in studyProjects" :key="p.id" class="row">
          <span>
            <NuxtLink :to="`/projects/${p.id}`">{{ p.title }}</NuxtLink>
            <span class="muted"> · {{ ROLE_LABELS[p.myRole] }}</span>
          </span>
          <span class="actions">
            <span class="badge">스터디 기록</span>
            <span v-if="p.studyNameMode === 'anonymous'" class="badge">익명 방</span>
          </span>
        </li>
      </ul>
    </section>

    <section v-if="checkins && checkins.projects.length > 0" class="card" aria-labelledby="checkin-card-heading">
      <h2 id="checkin-card-heading">이번 주 체크인</h2>
      <p class="hint">과제마다 60초: 투입 시간 · 체감 난이도 · 한 줄. 팀 안에서만 보입니다.</p>
      <p v-if="pendingCheckins.length === 0" class="muted">이번 주 체크인을 모두 냈습니다.</p>
      <ul class="plain">
        <li v-for="p in checkins.projects" :key="p.projectId" class="row">
          <NuxtLink :to="`/projects/${p.projectId}#checkin`">{{ p.title }}</NuxtLink>
          <span :class="p.submitted ? 'muted' : 'badge'">{{ p.submitted ? '✓ 냈음' : '아직 안 냄' }}</span>
        </li>
      </ul>
    </section>

    <section class="card" aria-labelledby="create-heading">
      <h2 id="create-heading">새 과제 만들기</h2>
      <p class="hint">과제 공간은 비공개로 만들어지며, 초대한 멤버만 볼 수 있습니다.</p>
      <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
      <form class="stack" novalidate @submit.prevent="create">
        <div class="field">
          <label for="title">과제 이름</label>
          <input
            id="title"
            v-model="form.title"
            required
            :aria-invalid="errors.title ? 'true' : undefined"
            :aria-describedby="errors.title ? 'title-error' : undefined"
          />
          <p v-if="errors.title" id="title-error" class="field-error">{{ fieldMessage(errors.title) }}</p>
        </div>
        <fieldset>
          <legend>형태</legend>
          <div class="inline-options">
            <label><input v-model="form.kind" type="radio" name="kind" value="individual" /> 개인</label>
            <label><input v-model="form.kind" type="radio" name="kind" value="team" /> 팀</label>
          </div>
        </fieldset>
        <CoursePicker v-model="form.courseTermId" id-prefix="new-course" />
        <p v-if="errors.courseTermId" class="field-error">{{ fieldMessage(errors.courseTermId) }}</p>
        <div class="field">
          <label class="check">
            <input v-model="form.retroMode" type="checkbox" aria-describedby="retro-hint" />
            지난 과제 되짚기(사후 작성)
          </label>
          <p id="retro-hint" class="hint">
            이미 끝난 과제를 파일 날짜·커밋 이력·발표 자료를 보며 거꾸로 정리합니다. 이때 쓰는 기록에는 ‘사후 작성’이 표시됩니다.
            나중에 운영 책임자가 켜고 끌 수 있습니다.
          </p>
        </div>
        <div class="actions">
          <button type="submit" :disabled="creating">{{ creating ? '만드는 중…' : '만들기' }}</button>
        </div>
      </form>
    </section>
  </div>
</template>
