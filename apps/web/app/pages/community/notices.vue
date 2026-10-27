<script setup lang="ts">
/**
 * 커뮤니티 알림(C-03, ADR 0020). 내가 멤버인 공간의 이름 표시 방식 변경 예약·취소·적용 소식과 내 글의 새 댓글(C-04, 개수만·쓴 사람 없음)입니다.
 * 메일·푸시 없이 화면 안에서만 보입니다.
 * 나갔거나 내보내진 공간은 이름을 보여 주지 않습니다. 로그인 전용·noindex.
 */
import type { CommunityNoticeDto, CommunityNoticesDto, NameModeNoticeDto } from '~~/shared/types/api'

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
  item_auto_hidden: '내 글·댓글이 운영 검토 중',
  item_restored: '내 글·댓글이 다시 보임',
  recruitment_invited: '모집에 선정됨',
  recruitment_not_selected: '모집 결과',
  recruitment_cancelled: '모집 취소',
  archive_consent_requested: '아카이브로 옮기기 동의 요청',
  archive_transfer_done: '아카이브로 옮기기 끝남',
  archive_transfer_cancelled: '아카이브로 옮기기 취소',
}

function textOf(n: CommunityNoticeDto): string {
  if (n.kind === 'post_commented') return postNoticeText({ count: n.count })
  if (n.kind === 'item_auto_hidden' || n.kind === 'item_restored') return n.text
  if (n.kind === 'recruitment_invited' || n.kind === 'recruitment_not_selected' || n.kind === 'recruitment_cancelled') return n.text
  if (n.kind === 'archive_consent_requested' || n.kind === 'archive_transfer_done' || n.kind === 'archive_transfer_cancelled') return n.text
  const m = n as NameModeNoticeDto
  return noticeText(m.kind, { fromMode: m.fromMode, toMode: m.toMode, effectiveAt: m.effectiveAt, ...(m.kind === 'name_mode_scheduled' && { joinPolicyAdjusted: m.joinPolicyAdjusted }) })
}

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
      내가 멤버인 방의 이름 표시 방식이 바뀌거나, 내 글에 새 댓글이 달리거나, 내 글·댓글이 신고로 운영 검토 중이 되거나, 지원한 모집의 결과가 나오거나, 내 답변을 아카이브로 옮기는 데 동의를 요청받으면 여기에 알립니다. 운영 조치·이용 제한의
      사유와 이의제기는 <NuxtLink to="/me/moderation-notices">운영 조치 안내</NuxtLink>에서 봅니다. 이름 표시 방식이 바뀌어도 이미 쓴 글·댓글은 쓸 때의 방식
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
          <p v-if="n.kind === 'recruitment_invited' || n.kind === 'recruitment_not_selected' || n.kind === 'recruitment_cancelled'">
            <NuxtLink :to="`/community/recruitments/${n.recruitmentId}`">{{ textOf(n) }}</NuxtLink>
          </p>
          <template v-else>
          <p>
            <NuxtLink v-if="n.space" :to="`/community/s/${n.space.slug}`">{{ n.space.name }}</NuxtLink>
            <span v-else class="muted">지금은 볼 수 없는 공간</span>
          </p>
          <p>
            <NuxtLink v-if="(n.kind === 'post_commented' || n.kind === 'item_auto_hidden' || n.kind === 'item_restored') && n.postId" :to="`/community/p/${n.postId}`">{{
              textOf(n)
            }}</NuxtLink>
            <NuxtLink
              v-else-if="(n.kind === 'archive_consent_requested' || n.kind === 'archive_transfer_done' || n.kind === 'archive_transfer_cancelled') && n.transferId"
              :to="`/community/archive-transfers/${n.transferId}`"
              :data-testid="`archive-notice-${n.kind}`"
              >{{ textOf(n) }}</NuxtLink
            >
            <template v-else>{{ textOf(n) }}</template>
          </p>
          </template>
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
