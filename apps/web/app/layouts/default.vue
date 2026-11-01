<script setup lang="ts">
const { me, logout } = useAuth()
</script>

<template>
  <div class="shell">
    <a class="skip-link" href="#main">본문으로 건너뛰기</a>
    <header class="site-header">
      <NuxtLink to="/" class="brand">Peerchive</NuxtLink>
      <HeaderSearch />
      <nav aria-label="주 메뉴">
        <ul class="nav-list">
          <template v-if="me">
            <li><NuxtLink to="/projects">내 과제</NuxtLink></li>
            <li><NuxtLink to="/me/courses">내 과목</NuxtLink></li>
            <li><NuxtLink to="/portfolio">포트폴리오</NuxtLink></li>
            <li><NuxtLink to="/community">커뮤니티</NuxtLink></li>
            <li><NuxtLink to="/feed">피드</NuxtLink></li>
            <li><NuxtLink to="/consents">동의 요청</NuxtLink></li>
            <li v-if="me.profile"><NuxtLink :to="`/u/${me.profile.handle}`">공개 프로필</NuxtLink></li>
            <li><NuxtLink to="/onboarding">프로필 설정</NuxtLink></li>
            <li><NuxtLink to="/settings/affiliations">학교 인증</NuxtLink></li>
            <li><NuxtLink to="/settings/personas">표시명 프로필</NuxtLink></li>
            <li><NuxtLink to="/settings/visibility">공개 범위</NuxtLink></li>
            <li><NuxtLink to="/settings/follows">팔로우·차단</NuxtLink></li>
            <li><NuxtLink to="/me/moderation-notices">알림</NuxtLink></li>
            <li v-if="me.operator"><NuxtLink to="/operator">운영</NuxtLink></li>
            <li>
              <span class="who">{{ me.displayName || '이름 미설정' }}</span>
              <button type="button" class="link-button" @click="logout">로그아웃</button>
            </li>
          </template>
          <li v-else><NuxtLink to="/login">로그인</NuxtLink></li>
        </ul>
      </nav>
    </header>
    <main id="main" class="page" tabindex="-1">
      <slot />
    </main>
  </div>
</template>
