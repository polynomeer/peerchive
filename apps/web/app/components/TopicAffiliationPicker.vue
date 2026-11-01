<script setup lang="ts">
/**
 * 토픽 글쓰기의 소속 표시 고르기(A-05, ADR 0042). 서버가 준 내 소속별 미리보기만 보여 줍니다(회원 수 없음).
 * 넓혀졌다는 안내는 이 화면(작성자 본인)에만 나옵니다. 실제 표시는 서버가 쓰는 순간 다시 정해 고정합니다.
 */
import type { AffiliationLabelScope, TopicComposerAffiliationDto } from '~~/shared/types/api'

const props = defineProps<{ affiliation: TopicComposerAffiliationDto; idPrefix: string }>()
const scope = defineModel<AffiliationLabelScope>('scope', { required: true })
const affiliationId = defineModel<string>('affiliationId', { required: true })

const SCOPE_TEXT: Record<AffiliationLabelScope, string> = {
  institution: '학교·기관 이름',
  institution_kind: '학교·기관 유형만',
  none: '표시 안 함',
}
const selected = computed(() => props.affiliation.options.find((o) => o.affiliationId === affiliationId.value) ?? props.affiliation.options[0] ?? null)
const preview = computed(() => selected.value?.previews[scope.value] ?? null)
</script>

<template>
  <fieldset class="topic-affiliation" :data-testid="`${idPrefix}-affiliation`">
    <legend>소속 표시</legend>
    <div v-if="affiliation.options.length > 1 && scope !== 'none'" class="field">
      <label :for="`${idPrefix}-affiliation-id`">표시할 소속</label>
      <select :id="`${idPrefix}-affiliation-id`" v-model="affiliationId">
        <option v-for="o in affiliation.options" :key="o.affiliationId" :value="o.affiliationId">{{ o.title }}</option>
      </select>
    </div>
    <div v-for="s in affiliation.scopes" :key="s" class="radio-row">
      <input :id="`${idPrefix}-scope-${s}`" v-model="scope" type="radio" :name="`${idPrefix}-scope`" :value="s" />
      <label :for="`${idPrefix}-scope-${s}`">{{ SCOPE_TEXT[s] }}</label>
    </div>
    <p class="hint" :data-testid="`${idPrefix}-affiliation-preview`">
      이렇게 보입니다: <strong>{{ preview?.label ?? '익명(소속 표시 없음)' }}</strong>
    </p>
    <p v-if="preview?.broadened" class="notice" role="status" :data-testid="`${idPrefix}-affiliation-broadened`">{{ affiliation.broadenedNote }}</p>
    <p class="hint">학과·기수·입학연도는 표시하지 않습니다. 쓴 뒤에는 소속이 바뀌어도 이 글의 표시는 바뀌지 않습니다.</p>
  </fieldset>
</template>
