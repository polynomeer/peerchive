<script setup lang="ts">
/**
 * 과목 허브 단계적 개방 진행(E-02, ADR 0047). 운영자가 아니면 404로 보입니다(API는 403 operator_only).
 * 공개 사례·선배 노트가 하나라도 있는 과목별 수와 기준만 보여 줍니다. 알림 신청·등록 같은 사람 정보는 없습니다.
 * 플래그가 꺼져 있어도 켰을 때의 상태(열림·준비 중)를 미리 볼 수 있습니다. 여닫기는 수동 조작 없이 기준으로만 정해집니다.
 */
import type { OperatorHubOpeningDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '과목 허브 개방 진행 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data, error } = await useFetch<OperatorHubOpeningDto>('/api/v1/operator/course-hubs/opening')
const denied = computed(() => !!error.value && [401, 403].includes(error.value.statusCode ?? 0))
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
</script>

<template>
  <div>
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
    </template>
    <template v-else-if="data">
      <h1>과목 허브 개방 진행</h1>
      <p class="hint">
        단계적 개방은 {{ data.stagedOpening ? '켜져 있습니다' : '꺼져 있습니다(모든 허브가 열려 있음, 아래는 켰을 때의 상태)' }}. 기준: 공개 사례 + 선배 노트
        {{ data.threshold }}개(<code>PEERCHIVE_HUB_OPEN_THRESHOLD</code>).
      </p>
      <p data-testid="hub-opening-summary">
        내용이 있는 과목 {{ data.summary.coursesWithContent }}개 · 열림 {{ data.summary.open }}개 · 준비 중 {{ data.summary.preparing }}개
      </p>
      <table v-if="data.items.length" class="ledger-table">
        <caption class="visually-hidden">과목별 공개 사례·선배 노트 수</caption>
        <thead>
          <tr><th scope="col">과목</th><th scope="col">공개 사례</th><th scope="col">선배 노트</th><th scope="col">합계 / 기준</th><th scope="col">상태</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in data.items" :key="item.course.id">
            <th scope="row"><NuxtLink :to="`/c/${item.course.id}`">{{ item.course.schoolName }} · {{ item.course.title }}</NuxtLink></th>
            <td>{{ item.cases }}</td>
            <td>{{ item.notes }}</td>
            <td>{{ item.total }} / {{ data.threshold }}</td>
            <td>{{ item.status === 'open' ? '열림' : '준비 중' }}<template v-if="item.openedAt"> · {{ formatDateTime(item.openedAt) }}부터(수가 줄어도 유지)</template></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">아직 공개 사례·선배 노트가 있는 과목이 없습니다.</p>
    </template>
    <p v-else class="notice error" role="alert">불러오지 못했습니다.</p>
  </div>
</template>
