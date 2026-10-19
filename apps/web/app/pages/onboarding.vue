<script setup lang="ts">
import type { MeDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '프로필 — Peerchive' })

const { me } = useAuth()
const isNew = computed(() => !me.value?.profile)
// 첫 저장(온보딩) 후에는 과제 목록으로 이동합니다.
const isNewBeforeSave = isNew.value

const form = reactive({
  handle: me.value?.profile?.handle ?? '',
  displayName: me.value?.displayName ?? '',
  headline: me.value?.profile?.headline ?? '',
  jobTargets: (me.value?.profile?.jobTargets ?? []).join(', '),
  schoolLabel: me.value?.profile?.schoolLabel ?? '',
  gradTerm: me.value?.profile?.gradTerm ?? '',
  contactPolicy: me.value?.profile?.contactPolicy ?? 'closed',
  openToWork: me.value?.profile?.openToWork ?? false,
})
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const message = ref<string | null>(null)
const failure = ref<string | null>(null)

async function save() {
  saving.value = true
  errors.value = {}
  message.value = null
  failure.value = null
  try {
    me.value = await $fetch<MeDto>('/api/v1/me/profile', {
      method: 'PATCH',
      body: {
        ...form,
        jobTargets: form.jobTargets
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    })
    if (isNewBeforeSave) {
      const invite = import.meta.client ? takePendingInvite() : null
      await navigateTo(invite ? `/invite/${invite}` : '/projects')
    } else {
      message.value = '저장했습니다.'
    }
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) errors.value = err.fields
    else failure.value = '저장하지 못했습니다. 입력한 내용은 그대로 있으니 다시 시도하세요.'
  } finally {
    saving.value = false
  }
}

const err = (field: string) => fieldMessage(errors.value[field])
const invalid = (field: string) => (errors.value[field] ? 'true' : undefined)
const described = (field: string, hint?: string) =>
  [hint, errors.value[field] ? `${field}-error` : undefined].filter(Boolean).join(' ') || undefined
</script>

<template>
  <div>
    <h1>{{ isNew ? '프로필 만들기' : '프로필 설정' }}</h1>
    <p class="muted">
      아래 정보는 공개 프로필(<code>/u/핸들</code>)에 표시됩니다. 이메일은 공개되지 않습니다.
      학교·졸업 시기는 선택이며 인증을 뜻하지 않습니다.
    </p>

    <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
    <p v-if="message" class="notice ok" role="status">{{ message }}</p>

    <form class="stack" novalidate @submit.prevent="save">
      <div class="field">
        <label for="handle">핸들 (필수)</label>
        <input
          id="handle"
          v-model="form.handle"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          required
          :aria-invalid="invalid('handle')"
          :aria-describedby="described('handle', 'handle-hint')"
        />
        <p id="handle-hint" class="hint">3–30자, 영문 소문자·숫자·하이픈(-). 공개 주소가 됩니다.</p>
        <p v-if="err('handle')" id="handle-error" class="field-error">{{ err('handle') }}</p>
      </div>

      <div class="field">
        <label for="displayName">표시 이름 (필수)</label>
        <input
          id="displayName"
          v-model="form.displayName"
          autocomplete="name"
          required
          :aria-invalid="invalid('displayName')"
          :aria-describedby="described('displayName')"
        />
        <p v-if="err('displayName')" id="displayName-error" class="field-error">{{ err('displayName') }}</p>
      </div>

      <div class="field">
        <label for="headline">한 줄 소개</label>
        <input id="headline" v-model="form.headline" :aria-invalid="invalid('headline')" :aria-describedby="described('headline')" />
        <p v-if="err('headline')" id="headline-error" class="field-error">{{ err('headline') }}</p>
      </div>

      <div class="field">
        <label for="jobTargets">희망 직무</label>
        <input
          id="jobTargets"
          v-model="form.jobTargets"
          :aria-invalid="invalid('jobTargets')"
          :aria-describedby="described('jobTargets', 'jobTargets-hint')"
        />
        <p id="jobTargets-hint" class="hint">쉼표로 구분, 최대 10개 (예: 백엔드, 데이터 엔지니어)</p>
        <p v-if="err('jobTargets')" id="jobTargets-error" class="field-error">{{ err('jobTargets') }}</p>
      </div>

      <div class="field">
        <label for="schoolLabel">학교 (선택)</label>
        <input id="schoolLabel" v-model="form.schoolLabel" :aria-invalid="invalid('schoolLabel')" :aria-describedby="described('schoolLabel')" />
        <p v-if="err('schoolLabel')" id="schoolLabel-error" class="field-error">{{ err('schoolLabel') }}</p>
      </div>

      <div class="field">
        <label for="gradTerm">졸업(예정) 시기 (선택)</label>
        <input
          id="gradTerm"
          v-model="form.gradTerm"
          type="month"
          placeholder="2027-02"
          :aria-invalid="invalid('gradTerm')"
          :aria-describedby="described('gradTerm', 'gradTerm-hint')"
        />
        <p id="gradTerm-hint" class="hint">YYYY-MM 형식</p>
        <p v-if="err('gradTerm')" id="gradTerm-error" class="field-error">{{ err('gradTerm') }}</p>
      </div>

      <div class="field">
        <label for="contactPolicy">연락 허용</label>
        <select id="contactPolicy" v-model="form.contactPolicy" :aria-invalid="invalid('contactPolicy')">
          <option value="closed">받지 않음</option>
          <option value="on_request">요청 시 검토</option>
          <option value="open">받음</option>
        </select>
      </div>

      <div class="field">
        <label><input v-model="form.openToWork" type="checkbox" /> 구직 중으로 표시</label>
      </div>

      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : '저장' }}</button>
      </div>
    </form>
  </div>
</template>
