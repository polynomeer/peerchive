<script setup lang="ts">
/**
 * 공개 페이지(/p/** 공개 사례, /c/** 과목 허브, /search 검색) 레이아웃(T-12, T-13). 로그인 상태를 읽지 않습니다: SSR HTML·payload에 보는 사람의 이름·이메일 같은
 * 비공개 정보가 들어가지 않게 하고, 로그인한 사람과 아닌 사람에게 같은 HTML을 줍니다.
 */
</script>

<template>
  <div class="shell">
    <a class="skip-link" href="#main">본문으로 건너뛰기</a>
    <header class="site-header">
      <NuxtLink to="/" class="brand">Peerchive</NuxtLink>
      <HeaderSearch />
      <nav aria-label="주 메뉴">
        <ul class="nav-list">
          <li><NuxtLink to="/projects">내 과제</NuxtLink></li>
        </ul>
      </nav>
    </header>
    <main id="main" class="page" tabindex="-1">
      <slot />
    </main>
  </div>
</template>
