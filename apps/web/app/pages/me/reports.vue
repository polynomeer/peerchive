<script setup lang="ts">
/**
 * 내 신고(T-15, ADR 0015). 신고한 대상과 처리 상태(접수·검토 중·처리됨·기각)만 보여 줍니다. 어떤 조치를 했는지는 알리지 않습니다.
 */
import type { MyReportDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '내 신고 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data: rows, error } = await useFetch<MyReportDto[]>('/api/v1/me/reports')
</script>

<template>
  <div>
    <h1>내 신고</h1>
    <p class="hint">
      신고는 운영자가 검토합니다. 신고한 사람은 게시자에게 알려지지 않으며, 여기에는 처리 상태만 보입니다(어떤 조치를 했는지는 알려 드리지 않습니다).
    </p>
    <p><NuxtLink to="/me/moderation-notices">내 게시물에 대한 운영 안내 보기</NuxtLink></p>
    <p v-if="error" class="notice error" role="alert">목록을 불러오지 못했습니다.</p>
    <ul v-else-if="rows?.length" class="plain operator-list">
      <li v-for="r in rows" :key="r.id">
        <p>
          <span class="badge">{{ REPORTER_STATUS_LABELS[r.status] }}</span>
          {{ r.targetLabel || REPORT_TARGET_LABELS[r.targetType] }}
        </p>
        <p class="small muted">
          사유: {{ REPORT_REASON_LABELS[r.reason] }} · 신고 {{ formatDateTime(r.createdAt) }}<template v-if="r.closedAt"> · 처리 {{ formatDateTime(r.closedAt) }}</template>
        </p>
      </li>
    </ul>
    <p v-else class="muted">아직 신고한 내용이 없습니다.</p>
  </div>
</template>
