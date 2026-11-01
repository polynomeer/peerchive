<script setup lang="ts">
useHead({ title: 'Peerchive — 과제는 끝나도, 과정은 남는다' })
const { me } = useAuth()
</script>

<template>
  <div class="home">
    <h1>Peerchive</h1>
    <p class="tagline">과제는 끝나도, 과정은 남는다</p>
    <p class="status" role="status">개발 중</p>
    <p>
      <NuxtLink v-if="me" to="/projects">내 과제로 가기</NuxtLink>
      <NuxtLink v-else to="/login">이메일로 시작하기</NuxtLink>
    </p>
    <!-- 이번 학기 과목(E-01): 본인에게만, 화면이 뜬 뒤 불러옵니다. -->
    <ClientOnly><CourseRegistrationCards v-if="me" /></ClientOnly>
    <!-- 과목 허브 소식(E-02): 단계적 개방이 켜져 있을 때 본인에게만(열림 알림·선배 노트 요청). -->
    <ClientOnly><HubOpeningNotices v-if="me" /></ClientOnly>
    <!-- 학생 큐레이터(E-03): 지금 큐레이터인 과목이 있을 때만. -->
    <ClientOnly><CuratorCourses v-if="me" /></ClientOnly>
  </div>
</template>

<style scoped>
.home {
  max-width: 40rem;
  margin: 0 auto;
  padding: 2rem 0;
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
