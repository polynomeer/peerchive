<script setup lang="ts">
import type { PublicProfileDto } from '~~/shared/types/api'

const route = useRoute()
const handle = computed(() => String(route.params.handle))
const { data: profile, error } = await useFetch<PublicProfileDto>(() => `/api/v1/profiles/${encodeURIComponent(handle.value)}`)

useHead({ title: () => (profile.value ? `${profile.value.displayName} (@${profile.value.handle}) — Peerchive` : '프로필 — Peerchive') })

const CONTACT_LABELS: Record<PublicProfileDto['contactPolicy'], string> = {
  closed: '연락 받지 않음',
  on_request: '요청 시 검토',
  open: '연락 받음',
}
</script>

<template>
  <div>
    <template v-if="error || !profile">
      <h1>프로필을 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <article v-else>
      <h1>{{ profile.displayName }} <span class="muted">@{{ profile.handle }}</span></h1>
      <p v-if="profile.headline">{{ profile.headline }}</p>
      <p class="actions">
        <span v-if="profile.openToWork" class="badge">구직 중</span>
        <span class="muted">{{ CONTACT_LABELS[profile.contactPolicy] }}</span>
      </p>
      <dl>
        <template v-if="profile.jobTargets.length">
          <dt>희망 직무</dt>
          <dd>{{ profile.jobTargets.join(', ') }}</dd>
        </template>
        <template v-if="profile.schoolLabel">
          <dt>학교 <span class="muted">(본인 입력)</span></dt>
          <dd>{{ profile.schoolLabel }}</dd>
        </template>
        <template v-if="profile.gradTerm">
          <dt>졸업(예정)</dt>
          <dd>{{ profile.gradTerm }}</dd>
        </template>
      </dl>
      <p class="muted">공개된 과제 사례는 아직 없습니다.</p>
    </article>
  </div>
</template>
