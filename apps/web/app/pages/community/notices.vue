<script setup lang="ts">
/**
 * 커뮤니티 알림(C-03, ADR 0020). 내가 멤버인 공간의 이름 표시 방식 변경 예약·취소·적용 소식과 내 글의 새 댓글(C-04, 개수만·쓴 사람 없음)입니다.
 * 메일·푸시 없이 화면 안에서만 보입니다.
 * 나갔거나 내보내진 공간은 이름을 보여 주지 않습니다. 로그인 전용·noindex.
 */
import type { CommunityNoticeDto, CommunityNoticesDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
// 제목·robots·referrer는 공통(C-05): 공간 이름으로 제목·OG를 만들지 않습니다. 헤더는 서버 미들웨어가 붙입니다.
useCommunityPage()

const fetcher = useRequestFetch()
const { data, error, refresh } = await useAsyncData('community-notices', () => fetcher<CommunityNoticesDto>('/api/v1/community/notices'))
const busy = ref(false)
const status = ref<string | null>(null)

const KIND_TITLES: Record<CommunityNoticeDto['kind'], string> = {
  name_mode_scheduled: '이름 표시 방식 변경 예약',
  name_mode_cancelled: '이름 표시 방식 변경 취소',
  name_mode_applied: '이름 표시 방식 변경 적용',
  post_commented: '내 글의 새 댓글',
}

const textOf = (n: CommunityNoticeDto) =>
  n.kind === 'post_commented'
    ? postNoticeText({ count: n.count })
    : noticeText(n.kind, { fromMode: n.fromMode, toMode: n.toMode, effectiveAt: n.effectiveAt, ...(n.kind === 'name_mode_scheduled' && { joinPolicyAdjusted: n.joinPolicyAdjusted }) })

async function markAll() {
  busy.value = true
  status.value = null
  try {
    await $fetch('/api/v1/community/notices/read', { method: 'POST', body: { all: true } })
    await refresh()
    status.value = '모두 읽음으로 표시했습니다.'
  } catch {
    status.value = '처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="community-page">
    <h1>커뮤니티 알림</h1>
    <p class="hint">
      내가 멤버인 방의 이름 표시 방식이 바뀌거나 내 글에 새 댓글이 달리면 여기에 알립니다. 이름 표시 방식이 바뀌어도 이미 쓴 글·댓글은 쓸 때의 방식
      그대로입니다.
    </p>
    <p v-if="status" class="notice" role="status">{{ status }}</p>
    <p v-if="error" class="notice error" role="alert">알림을 불러오지 못했습니다.</p>
    <template v-else-if="data?.items.length">
      <p class="actions">
        <span>읽지 않음 {{ data.unread }}개</span>
        <button v-if="data.unread" type="button" class="secondary" :disabled="busy" @click="markAll">모두 읽음</button>
      </p>
      <ul class="plain hub-list">
        <li v-for="n in data.items" :key="n.id" class="hub-card">
          <p>
            <strong>{{ KIND_TITLES[n.kind] }}</strong>
            <span v-if="!n.readAt" class="badge">새 알림</span>
          </p>
          <p>
            <NuxtLink v-if="n.space" :to="`/community/s/${n.space.slug}`">{{ n.space.name }}</NuxtLink>
            <span v-else class="muted">지금은 볼 수 없는 공간</span>
          </p>
          <p>
            <NuxtLink v-if="n.kind === 'post_commented' && n.postId" :to="`/community/p/${n.postId}`">{{ textOf(n) }}</NuxtLink>
            <template v-else>{{ textOf(n) }}</template>
          </p>
          <p class="small muted">
            {{ formatDateTime(n.createdAt) }}<template v-if="n.kind === 'name_mode_scheduled'"> · 적용 예정 {{ formatDateTime(n.effectiveAt) }}</template>
          </p>
        </li>
      </ul>
    </template>
    <p v-else class="muted">알림이 없습니다.</p>
    <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
  </div>
</template>
