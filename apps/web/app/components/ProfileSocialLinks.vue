<script setup lang="ts">
/**
 * 공개 프로필의 소셜 링크(S-06, ADR 0034). 공개 API가 준 그 페르소나의 링크만 그립니다.
 * - `링크 확인됨` 배지는 "그 계정에 이 Peerchive 프로필 링크가 있음"만 뜻합니다. 인물·경력 검증으로 읽히지 않게 설명을 늘 함께 둡니다.
 * - 외부 링크는 `rel="nofollow noopener noreferrer ugc"`로 엽니다(확인된 링크도 검색 순위 신호를 넘기지 않음). 인쇄 보기는 주소를 함께 적습니다.
 */
import { SOCIAL_LINK_PROVIDER_LABELS, SOCIAL_LINK_VERIFIED_LABEL, SOCIAL_LINK_VERIFIED_NOTE } from '@peerchive/domain'
import type { PublicSocialLinkDto } from '~~/shared/types/api'

const props = defineProps<{ links: PublicSocialLinkDto[]; print?: boolean }>()
const anyVerified = computed(() => props.links.some((l) => l.verified))
const shortUrl = (url: string) => url.replace(/^https:\/\//, '').replace(/\/$/, '')
</script>

<template>
  <section v-if="links.length" class="profile-links" aria-labelledby="profile-links-heading" :class="{ 'report-member': print }">
    <h2 id="profile-links-heading" :class="{ 'visually-hidden': !print }">링크</h2>
    <ul :class="print ? 'report-small' : 'plain actions small'">
      <li v-for="link in links" :key="link.url">
        <template v-if="print">
          {{ SOCIAL_LINK_PROVIDER_LABELS[link.provider] }}: {{ link.url }}<template v-if="link.verified"> ({{ SOCIAL_LINK_VERIFIED_LABEL }})</template>
        </template>
        <template v-else>
          <a :href="link.url" rel="nofollow noopener noreferrer ugc" target="_blank">{{ SOCIAL_LINK_PROVIDER_LABELS[link.provider] }} · {{ shortUrl(link.url) }}</a>
          <span v-if="link.verified" class="badge" :title="SOCIAL_LINK_VERIFIED_NOTE"> {{ SOCIAL_LINK_VERIFIED_LABEL }}</span>
        </template>
      </li>
    </ul>
    <p v-if="anyVerified" :class="print ? 'report-small report-muted' : 'hint'">{{ SOCIAL_LINK_VERIFIED_LABEL }} — {{ SOCIAL_LINK_VERIFIED_NOTE }}.</p>
  </section>
</template>

<style scoped>
.profile-links a,
.profile-links li {
  overflow-wrap: anywhere;
}
</style>
