<script setup lang="ts">
/**
 * 기관 운영진 지정·해제(I-02, ADR 0044). 운영자만(아니면 "찾을 수 없습니다"). P2 플래그 institutions가 꺼져 있으면 API가 404라 같은 화면입니다.
 * 기관을 검색해 고르고, 사용자 id로 운영진을 지정·해제합니다(감사에는 id만). 기관 페이지 개설은 `커뮤니티 운영`에서 합니다.
 */
import type { InstitutionDto, InstitutionStaffDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '기관 운영진 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

// 운영자·플래그 판정: 같은 영역(institutions)의 운영자 전용 목록을 한 번 읽어 403·404면 "찾을 수 없습니다"(감사 기록 없음, 파일 정보 없음).
const { error } = await useFetch('/api/v1/operator/certificate-checks', { query: { status: 'pending' } })
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const q = ref('')
const results = ref<InstitutionDto[]>([])
const selected = ref<InstitutionDto | null>(null)
const staff = ref<InstitutionStaffDto[]>([])
const userId = ref('')
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function search() {
  results.value = q.value.trim() ? await $fetch<InstitutionDto[]>('/api/v1/institutions', { query: { q: q.value } }) : []
}
async function pick(i: InstitutionDto) {
  selected.value = i
  notice.value = null
  staff.value = await $fetch<InstitutionStaffDto[]>(`/api/v1/operator/institutions/${i.id}/staff`)
}
async function grant() {
  if (!selected.value) return
  notice.value = null
  try {
    staff.value = await $fetch<InstitutionStaffDto[]>(`/api/v1/operator/institutions/${selected.value.id}/staff`, { method: 'POST', body: { userId: userId.value.trim() } })
    userId.value = ''
    notice.value = { kind: 'ok', text: '운영진으로 지정했습니다.' }
  } catch (e) {
    const err = apiError(e)
    notice.value = {
      kind: 'error',
      text: err.code === 'already_staff' ? '이미 운영진입니다.' : err.fields.userId === 'not_found' || err.fields.userId === 'invalid' ? '사용자 id를 확인하세요.' : err.fields.userId === 'inactive' ? '활성 계정이 아닙니다.' : '지정하지 못했습니다.',
    }
  }
}
async function revoke(s: InstitutionStaffDto) {
  if (!selected.value || !window.confirm(`${s.displayName}의 운영진 지정을 해제할까요?`)) return
  staff.value = await $fetch<InstitutionStaffDto[]>(`/api/v1/operator/institutions/${selected.value.id}/staff/${s.userId}`, { method: 'DELETE' })
  notice.value = { kind: 'ok', text: '해제했습니다.' }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
    </template>
    <template v-else>
      <h1>기관 운영진</h1>
      <p class="hint">
        운영진은 자기 기관의 기관 페이지·기수 방에서 모더레이터 범위의 조치와 초대 코드 발급만 합니다. 작성자 확인·수료증 확인·소속 사용자 조회 권한은 없습니다.
        지정 전에 기관과의 협력 범위(RUNBOOK “기관 운영진”)를 확인하세요.
      </p>
      <form class="actions" @submit.prevent="search">
        <input v-model="q" aria-label="기관 이름" placeholder="기관 이름" maxlength="100" />
        <button type="submit" class="secondary">검색</button>
      </form>
      <ul v-if="results.length" class="plain">
        <li v-for="i in results" :key="i.id">
          <button type="button" class="link" @click="pick(i)">{{ i.name }}</button> · {{ INSTITUTION_KIND_LABELS[i.kind] }}
        </li>
      </ul>
      <section v-if="selected" aria-labelledby="staff-list">
        <h2 id="staff-list">{{ selected.name }} 운영진</h2>
        <p class="small muted">기관 id <span class="mono">{{ selected.id }}</span>(기관 페이지 개설에 씀) · <NuxtLink :to="`/institutions/manage/${selected.id}`">기관 운영 화면</NuxtLink></p>
        <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
        <ul v-if="staff.length" class="plain hub-list">
          <li v-for="s in staff" :key="s.id" class="hub-card">
            <p>{{ s.displayName }} <span class="small muted">{{ s.userId }} · {{ seoulDay(s.grantedAt) }} 지정</span></p>
            <p class="actions"><button type="button" class="danger" @click="revoke(s)">해제</button></p>
          </li>
        </ul>
        <p v-else class="muted">지정된 운영진이 없습니다.</p>
        <form class="actions" @submit.prevent="grant">
          <input v-model="userId" aria-label="사용자 id" placeholder="사용자 id(uuid)" />
          <button type="submit">운영진 지정</button>
        </form>
      </section>
    </template>
  </div>
</template>
