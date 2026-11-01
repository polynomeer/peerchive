<script setup lang="ts">
/**
 * 막힘 Q&A 글의 작성자 확인(E-04, ADR 0049). 이 신고에 묶여서만 확인할 수 있고, 확인할 때마다 감사 기록(글 id·신고 id)이 남습니다.
 * 결과(내부 id·handle·계정 상태)는 이 화면의 이 응답에만 있고 다른 목록에 다시 나오지 않습니다.
 */
import type { StuckQaAuthorLookupDto } from '~~/shared/types/api'

const props = defineProps<{ postId: string; reportId: string }>()
const result = ref<StuckQaAuthorLookupDto | null>(null)
const busy = ref(false)
const error = ref('')

async function lookup() {
  error.value = ''
  busy.value = true
  try {
    result.value = await $fetch<StuckQaAuthorLookupDto>(`/api/v1/operator/stuck-qa/posts/${props.postId}/author-lookup`, {
      method: 'POST',
      body: { reportId: props.reportId },
    })
  } catch (e) {
    error.value = moderationErrorMessage(apiError(e).code)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stuck-qa-lookup" data-testid="op-stuck-qa-lookup">
    <p class="actions small">
      <button type="button" class="secondary" :disabled="busy" @click="lookup">작성자 확인(감사 기록)</button>
    </p>
    <p v-if="error" class="field-error" role="alert">{{ error }}</p>
    <p v-if="result" class="small" data-testid="op-stuck-qa-author">
      <template v-if="result.author">
        내부 id {{ result.author.userId }}<template v-if="result.author.handle"> · @{{ result.author.handle }}</template> · 계정 {{ result.author.status }}
      </template>
      <template v-else>작성자 계정을 찾을 수 없습니다.</template>
      <template v-if="result.byLogAuthor"> · 막힘 로그 작성자로 쓴 글</template>
    </p>
  </div>
</template>
