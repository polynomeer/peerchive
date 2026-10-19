<script setup lang="ts">
import type { ProjectDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '내 과제 — Peerchive' })

const { data: projects, error: loadError } = await useFetch<ProjectDto[]>('/api/v1/projects', {
  default: () => [],
})

const form = reactive({ title: '', kind: 'individual' as 'individual' | 'team' })
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

const KIND_LABELS = { individual: '개인', team: '팀' } as const
</script>

<template>
  <div>
    <h1>내 과제</h1>

    <p v-if="loadError" class="notice error" role="alert">목록을 불러오지 못했습니다.</p>
    <p v-else-if="projects.length === 0" class="muted">아직 과제가 없습니다. 아래에서 첫 과제를 만들어 보세요.</p>
    <ul v-else class="plain">
      <li v-for="p in projects" :key="p.id" class="row">
        <span>
          <NuxtLink :to="`/projects/${p.id}`">{{ p.title }}</NuxtLink>
          <span class="muted"> · {{ KIND_LABELS[p.kind] }} · {{ ROLE_LABELS[p.myRole] }}</span>
        </span>
        <span class="badge private">🔒 팀만 보기</span>
      </li>
    </ul>

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
        <div class="actions">
          <button type="submit" :disabled="creating">{{ creating ? '만드는 중…' : '만들기' }}</button>
        </div>
      </form>
    </section>
  </div>
</template>
