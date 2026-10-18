<script setup lang="ts">
useHead({ title: 'Peerchive — 과제는 끝나도, 과정은 남는다' })
</script>

<template>
  <main class="home">
    <h1>Peerchive</h1>
    <p class="tagline">과제는 끝나도, 과정은 남는다</p>
    <p class="status" role="status">개발 중</p>
  </main>
</template>

<style scoped>
.home {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1rem;
  font-family: system-ui, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
  line-height: 1.6;
}
.tagline {
  font-size: 1.25rem;
}
.status {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 0.875rem;
}
</style>
