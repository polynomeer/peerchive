<script setup lang="ts">
/**
 * 사후 작성 안내(T-07, PROOFU_EVOLUTION_PLAN §6.7). 지난 과제를 30분 안에 되짚는 순서를 보여 줍니다
 * (docs/research/supply-kit.md §4의 단계). 닫으면 상위가 프로젝트별로 기억합니다.
 */
const emit = defineEmits<{ dismiss: [] }>()

const STEPS = [
  { title: '과제 요약', time: '5분', text: '과제 한 줄 요약, 기간, 팀 규모, 내 역할을 개요에 적습니다. 제출물·단톡방을 참고하세요.' },
  {
    title: '마일스톤 3~5개와 스냅샷',
    time: '10분',
    text: '파일 수정일·커밋 이력·발표 자료 버전을 보고 단계를 나눈 뒤, 각 시점의 산출물을 스냅샷으로 지정합니다.',
  },
  {
    title: '결정·막힘',
    time: '10분',
    text: '기억나는 ⚖️결정 1~2개(선택지 → 기준 → 선택 → 지나고 보니)와 🧱막힘 1~3개를 빌드 로그로 남깁니다.',
  },
  { title: '회고', time: '5분', text: '🔁회고 로그로 배운 점과 다시 한다면 무엇을 바꿀지 적습니다.' },
] as const
</script>

<template>
  <section class="card retro-guide" aria-labelledby="retro-guide-heading">
    <div class="task-prompt-head">
      <h2 id="retro-guide-heading">지난 과제 되짚기 안내</h2>
      <button type="button" class="link-button" aria-label="사후 작성 안내 닫기" @click="emit('dismiss')">닫기</button>
    </div>
    <p class="hint">
      이 과제는 <strong>사후 작성</strong> 모드입니다. 지금 쓰는 로그·마일스톤·스냅샷에는 ‘사후 작성’이 표시되고, 날짜는 기억·파일 기준으로
      스스로 적는 값입니다. 진행 중에 남긴 기록보다 신뢰 표시가 낮다는 점을 숨기지 않습니다.
    </p>
    <ol class="retro-steps">
      <li v-for="step in STEPS" :key="step.title">
        <strong>{{ step.title }}</strong> <span class="muted">({{ step.time }})</span>
        <p class="small">{{ step.text }}</p>
      </li>
    </ol>
  </section>
</template>
