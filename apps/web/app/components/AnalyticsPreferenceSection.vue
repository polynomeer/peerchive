<script setup lang="ts">
/**
 * pilot 분석 수집 설정(T-16, ADR 0016). 수집하는 것은 기능 사용 여부·개수(예: 로그 태그, 근거 개수)뿐이며 과제 본문·제목·파일·검색어·연락처는 없습니다.
 * 거부하면 이후 이벤트를 만들지 않고 지난 이벤트도 지웁니다.
 */
const { me } = useAuth()
const optOut = ref(me.value?.analyticsOptOut ?? false)
const saving = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function save() {
  saving.value = true
  notice.value = null
  try {
    const result = await $fetch<{ analyticsOptOut: boolean; deletedEvents: number }>('/api/v1/me/preferences', {
      method: 'PATCH',
      body: { analyticsOptOut: optOut.value },
    })
    if (me.value) me.value = { ...me.value, analyticsOptOut: result.analyticsOptOut }
    notice.value = { kind: 'ok', text: result.analyticsOptOut ? '수집을 껐고 지난 기록도 지웠습니다.' : '수집을 켰습니다.' }
  } catch {
    optOut.value = me.value?.analyticsOptOut ?? false
    notice.value = { kind: 'error', text: '설정을 바꾸지 못했습니다. 다시 시도하세요.' }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section id="analytics" class="card" aria-labelledby="analytics-heading">
    <h2 id="analytics-heading">파일럿 사용 기록</h2>
    <!-- 파일럿 동의 문구 자리: 실제 문구·보존 기간·분석 접근 권한은 파일럿 안내문 확정 뒤 바꿉니다(DELIVERY_PLAN §6). -->
    <p class="hint">
      [파일럿 동의 안내 문구 자리] 서비스 개선을 위해 어떤 기능을 썼는지(예: 로그를 남김, 근거 개수)만 가명으로 기록합니다.
      과제 내용·제목·파일·검색어·연락처는 기록하지 않습니다. 언제든 끌 수 있고, 끄면 지난 기록도 지웁니다.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <div class="field">
      <label><input v-model="optOut" type="checkbox" :disabled="saving" @change="save" /> 사용 기록 수집 거부</label>
    </div>
  </section>
</template>
