<script setup lang="ts">
/** 머리말 검색 상자(T-13). 자바스크립트 없이도 동작하는 GET 폼(`/search?q=`)입니다. 공개 내용만 찾습니다. */
</script>

<template>
  <form class="header-search" role="search" action="/search" method="get">
    <label class="visually-hidden" for="header-search-q">공개 사례·막힘·선배 노트 검색</label>
    <input id="header-search-q" name="q" type="search" maxlength="100" placeholder="과목·막힘 검색" />
    <button type="submit" class="secondary">검색</button>
  </form>
</template>
