<script setup lang="ts">
/** 내가 운영진인 기관(I-02, ADR 0044). 운영진이 아니면 빈 목록, P2 플래그 institutions가 꺼져 있으면 "찾을 수 없습니다". */
import type { InstitutionDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '기관 운영 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data: items, error } = await useFetch<InstitutionDto[]>('/api/v1/me/institution-staff')
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <h1>기관 운영</h1>
      <ul v-if="items?.length" class="plain hub-list">
        <li v-for="i in items" :key="i.id" class="hub-card">
          <NuxtLink :to="`/institutions/manage/${i.id}`"><strong>{{ i.name }}</strong></NuxtLink> · {{ INSTITUTION_KIND_LABELS[i.kind] }}
        </li>
      </ul>
      <p v-else class="muted">운영진으로 지정된 기관이 없습니다. 기관 운영진은 Peerchive 운영자가 지정합니다.</p>
    </template>
  </div>
</template>
