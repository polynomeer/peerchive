<script setup lang="ts">
/**
 * 내 게시물에 대한 운영 안내(T-15, ADR 0015). 메일 없이 화면 안에서만 알립니다. 운영자가 "당사자에게 알림"을 켠 조치만 나오고,
 * 당사자용 사유·이의 상태만 보입니다(내부 메모·신고 내용·신고자 없음). 이의제기는 조치마다 한 번입니다.
 */
import type { ModerationNoticeDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '운영 안내 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const { data: notices, error, refresh } = await useFetch<ModerationNoticeDto[]>('/api/v1/me/moderation-notices')
const { me } = useAuth()
</script>

<template>
  <div>
    <h1>운영 안내</h1>
    <p class="hint">운영자가 내 공개 사례·선배 노트·케이스 스터디·공개 프로필에 조치를 하면 여기에 보입니다. 사유가 맞지 않으면 이의를 제기할 수 있습니다.</p>
    <p v-if="me?.profileHidden" class="notice error" role="status">내 공개 프로필이 운영 조치로 숨겨져 있습니다. 계정과 과제 공간은 그대로 쓸 수 있습니다.</p>
    <p><NuxtLink to="/me/reports">내가 한 신고 보기</NuxtLink></p>
    <p v-if="error" class="notice error" role="alert">목록을 불러오지 못했습니다.</p>
    <template v-else-if="notices?.length">
      <ModerationNotice v-for="n in notices" :key="n.actionId" :notice="n" :id-prefix="`me-${n.actionId}`" show-target @appealed="refresh()" />
    </template>
    <p v-else class="muted">운영 안내가 없습니다.</p>
  </div>
</template>
