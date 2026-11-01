<script setup lang="ts">
/**
 * 기수 승인(I-01, SYSTEM_DESIGN §6.7.2 CohortApproval, ADR 0037). 요청한 사람이 같은 기수 멤버에게 직접 보낸 링크로 엽니다.
 * 같은 기관·같은 기수에서 기수 승인이 아닌 수단(초대 코드·수료증 확인)으로 인증된 멤버에게만 보이고, 그 밖에는 "찾을 수 없음"입니다.
 * P2 플래그 institutions가 꺼져 있으면 API가 404라 같은 화면입니다.
 */
import type { CohortApprovalRequestDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '기수 승인 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const id = computed(() => String(route.params.id ?? ''))
const { data: request, error, refresh } = await useAsyncData(`cohort-approval-${id.value}`, () =>
  useRequestFetch()<CohortApprovalRequestDto>(`/api/v1/affiliations/${id.value}/cohort-approval`),
)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)

async function approve() {
  if (!request.value) return
  if (!window.confirm(`${request.value.requesterName} 님이 ${request.value.institution.name} ${request.value.cohortLabel} 멤버가 맞나요? 승인 기록은 남습니다.`)) return
  busy.value = true
  notice.value = null
  try {
    request.value = await $fetch<CohortApprovalRequestDto>(`/api/v1/affiliations/${id.value}/cohort-approvals`, { method: 'POST' })
    notice.value = { kind: 'ok', text: request.value.status === 'active' ? '승인했습니다. 승인이 모여 인증되었습니다.' : '승인했습니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: affiliationErrorMessage(apiError(e).code) }
    await refresh()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="affiliation-page">
    <template v-if="error || !request">
      <h1>찾을 수 없습니다</h1>
      <p>이 요청을 승인할 수 있는 같은 기수 멤버만 볼 수 있습니다. 기수 승인으로 인증된 계정은 승인할 수 없습니다.</p>
    </template>
    <template v-else>
      <h1>기수 승인</h1>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <p>
        <strong>{{ request.requesterName }}</strong> 님이 <strong>{{ request.institution.name }}</strong> ({{ INSTITUTION_KIND_LABELS[request.institution.kind] }})
        <strong>{{ request.cohortLabel }}</strong> 멤버라고 인증을 요청했습니다.
      </p>
      <p class="small">승인 {{ request.approvals }} / {{ request.required }} · {{ affiliationStatusLabel({ status: request.status, method: 'cohort_approval' }) }}</p>
      <p class="hint">직접 아는 같은 기수 멤버일 때만 승인하세요. 사칭으로 판정된 요청을 승인하면 이후 승인 자격이 제한될 수 있습니다.</p>
      <p class="actions">
        <button type="button" :disabled="busy || request.approvedByMe || request.status !== 'pending'" @click="approve">
          {{ request.approvedByMe ? '승인함' : '승인하기' }}
        </button>
      </p>
    </template>
  </div>
</template>
