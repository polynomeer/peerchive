<script setup lang="ts">
/**
 * 과제 공간의 기여 섹션(T-08, PROOFU_EVOLUTION_PLAN §7): 내 역할 선언, 팀원 선언과 확인, 기간 요약, 동료평가 리포트 링크.
 * - 선언·확인은 owner/editor/reviewer, viewer는 읽기만 합니다.
 * - "팀원 확인"은 그 팀원이 선언을 인정했다는 뜻일 뿐, 교수 인증·능력 검증이 아님을 안내합니다.
 */
import type { ClaimDto, ProjectRole } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; myRole: ProjectRole; meId: string | null }>()

const claims = ref<ClaimDto[]>([])
const loaded = ref(false)
const loadError = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
/** 선언·확인이 바뀌면 요약 표도 다시 불러옵니다. */
const ledgerKey = ref(0)

const mayDeclare = computed(() => canDeclare(props.myRole))
const mine = computed(() => claims.value.filter((c) => c.author.userId === props.meId))

async function refresh() {
  try {
    claims.value = await $fetch<ClaimDto[]>(`/api/v1/projects/${props.projectId}/claims`)
    loadError.value = false
  } catch {
    loadError.value = true
  } finally {
    loaded.value = true
  }
  ledgerKey.value += 1
}

function onCreated(claim: ClaimDto) {
  notice.value = { kind: 'ok', text: '역할을 선언했습니다. 팀원이 확인하면 “팀원 확인”으로 바뀝니다.' }
  claims.value = [...claims.value, claim]
  void refresh()
}

function onUpdated(claim: ClaimDto) {
  claims.value = claims.value.map((c) => (c.id === claim.id ? claim : c))
  ledgerKey.value += 1
}

onMounted(refresh)
</script>

<template>
  <section class="card" aria-labelledby="contribution-heading">
    <h2 id="contribution-heading">기여</h2>
    <p class="hint">
      각자 맡은 일을 선언하고 로그·파일을 근거로 연결합니다. 활동량을 점수나 순위로 바꾸지 않습니다.
      “팀원 확인”은 그 팀원이 선언을 인정했다는 뜻일 뿐, 교수 인증이나 능력 검증이 아닙니다.
    </p>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <h3 id="claim-new-heading">내 역할 선언</h3>
    <template v-if="mayDeclare">
      <p v-if="mine.length >= CLAIM_LIMIT_PER_MEMBER" class="hint">역할 선언은 한 사람당 {{ CLAIM_LIMIT_PER_MEMBER }}개까지입니다. 있는 선언을 고쳐 주세요.</p>
      <ClaimForm v-else id-prefix="claim-new" :project-id="projectId" @saved="onCreated" />
    </template>
    <p v-else class="hint">열람자는 선언과 확인을 볼 수만 있습니다.</p>

    <h3 id="claims-heading">팀원 선언</h3>
    <p v-if="loadError" class="notice error" role="alert">
      선언을 불러오지 못했습니다. <button type="button" class="link-button" @click="refresh">다시 시도</button>
    </p>
    <p v-else-if="loaded && claims.length === 0" class="muted">아직 역할 선언이 없습니다.</p>
    <ul v-else class="plain claim-list" aria-labelledby="claims-heading">
      <li v-for="claim in claims" :key="claim.id">
        <ClaimItem :claim="claim" :me-id="meId" @updated="onUpdated" @reload="refresh" />
      </li>
    </ul>

    <ContributionLedger :project-id="projectId" :refresh-key="ledgerKey" />
  </section>
</template>
