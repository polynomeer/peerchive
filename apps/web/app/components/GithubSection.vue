<script setup lang="ts">
/**
 * 과제의 GitHub 저장소 연결과 근거 후보(E-11, ADR 0056).
 * - owner: "GitHub 연결" → GitHub App 설치(저장소 선택) → 사용자 확인 → 돌아와서 저장소 하나를 고름. 해제하면 수집을 멈추고 후보를 지웁니다.
 * - 멤버: 연결된 저장소와 멤버별 커밋·PR 후보를 봅니다. 후보는 자동으로 확정·집계되지 않습니다. 본인 것은 역할 선언 폼에서 근거로 고르고,
 *   로그에는 주소를 링크로 붙일 수 있습니다(링크는 학생이 고른 주소·제목만 공개 대상이 되며, 비공개 저장소면 공개 전 점검이 경고합니다).
 * GitHub App 설정이 없으면 부모가 이 컴포넌트를 그리지 않습니다.
 */
import type { GithubCandidatesDto, GithubRedirectDto, ProjectGithubDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; isOwner: boolean }>()
const route = useRoute()

const status = ref<ProjectGithubDto | null>(null)
const candidates = ref<GithubCandidatesDto | null>(null)
const loadError = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(githubResultNotice(route.query.github))
const busy = ref(false)
const choice = ref<number | null>(null)

async function load() {
  try {
    status.value = await $fetch<ProjectGithubDto>(`/api/v1/projects/${props.projectId}/github`)
    candidates.value = status.value.link ? await $fetch<GithubCandidatesDto>(`/api/v1/projects/${props.projectId}/github/items`) : null
    loadError.value = false
  } catch {
    loadError.value = true
  }
}
onMounted(load)

async function install() {
  busy.value = true
  notice.value = null
  try {
    const { url } = await $fetch<GithubRedirectDto>(`/api/v1/projects/${props.projectId}/github/install`, { method: 'POST' })
    window.location.assign(url)
  } catch (e) {
    busy.value = false
    notice.value = { kind: 'error', text: githubErrorText(apiError(e).code) }
  }
}

async function linkRepo() {
  if (choice.value === null) return
  busy.value = true
  notice.value = null
  try {
    status.value = await $fetch<ProjectGithubDto>(`/api/v1/projects/${props.projectId}/github/link`, { method: 'POST', body: { repoId: choice.value } })
    notice.value = { kind: 'ok', text: '저장소를 연결했습니다. 이제부터 올라오는 커밋·PR이 근거 후보로 쌓입니다.' }
    await load()
  } catch (e) {
    notice.value = { kind: 'error', text: githubErrorText(apiError(e).code) }
  } finally {
    busy.value = false
  }
}

async function unlinkRepo() {
  if (!confirm('저장소 연결을 해제할까요? 수집을 멈추고 지금까지 모은 후보를 지웁니다. 이미 선언 근거로 고른 커밋·PR은 링크로만 남습니다.')) return
  try {
    await $fetch(`/api/v1/projects/${props.projectId}/github`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: '연결을 해제했습니다. GitHub에서 앱 설치를 지우려면 GitHub 설정(Installed GitHub Apps)에서 하세요.' }
    await load()
  } catch (e) {
    notice.value = { kind: 'error', text: githubErrorText(apiError(e).code) }
  }
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    notice.value = { kind: 'ok', text: '주소를 복사했습니다. 로그의 링크 칸에 붙이면 근거 링크가 됩니다.' }
  } catch {
    notice.value = { kind: 'error', text: '복사하지 못했습니다.' }
  }
}
</script>

<template>
  <section id="github" class="card" aria-labelledby="github-heading" data-testid="github-section">
    <h2 id="github-heading">GitHub 저장소</h2>
    <p class="hint">
      저장소를 연결하면 팀원의 커밋·PR이 기여 장부의 <strong>근거 후보</strong>로 쌓입니다. 후보는 자동으로 확정·집계되지 않고, 본인이 역할 선언의 근거로 골라야 쓰입니다.
      파일 내용·diff는 받지 않고 제목 첫 줄·주소·작성자·시각만 저장하며, 이 과제의 멤버만 봅니다. 각자
      <NuxtLink to="/onboarding#github">프로필 설정</NuxtLink>에서 GitHub 계정을 연결해야 자기 커밋이 후보가 됩니다.
    </p>
    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    <p v-if="loadError" class="notice error" role="alert">
      GitHub 연결 상태를 불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>
    <template v-else-if="status">
      <template v-if="status.link">
        <p>
          연결됨: <a :href="status.link.htmlUrl" target="_blank" rel="noopener noreferrer">{{ status.link.fullName }}</a>
          <span v-if="status.link.private" class="badge">비공개 저장소</span>
          <span class="muted"> · {{ new Date(status.link.linkedAt).toLocaleDateString('ko-KR') }}</span>
        </p>
        <p v-if="status.link.private" class="hint">비공개 저장소의 커밋 제목은 공개 사례에 자동으로 들어가지 않습니다. 로그에 링크로 붙이면 공개 전 점검이 경고합니다.</p>
        <p v-if="!status.identityLinked" class="muted">내 GitHub 계정이 연결되어 있지 않아 내 커밋·PR은 후보로 보이지 않습니다.</p>
        <div v-if="status.canManage" class="actions">
          <button type="button" class="danger" @click="unlinkRepo">저장소 연결 해제</button>
        </div>

        <div v-if="candidates?.linked" class="stack" style="margin-top: 1rem">
          <h3>멤버별 근거 후보 <span class="muted small">(자동 확정·집계 없음)</span></h3>
          <div v-for="entry in candidates.members" :key="entry.member.userId">
            <h4>{{ entry.member.displayName || '이름 미설정' }}</h4>
            <p v-if="!entry.identityLinked" class="muted small">GitHub 계정 미연결</p>
            <p v-else-if="entry.items.length === 0" class="muted small">후보 없음</p>
            <ul v-else class="plain">
              <li v-for="item in entry.items" :key="item.id" class="row">
                <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ githubItemLabel(item) }}</a>
                <button type="button" class="link-button small" @click="copy(item.url)">주소 복사</button>
              </li>
            </ul>
          </div>
        </div>
      </template>
      <template v-else>
        <p class="muted">연결된 저장소가 없습니다.</p>
        <form v-if="status.canManage && status.pendingChoices?.length" class="stack" @submit.prevent="linkRepo">
          <fieldset>
            <legend>이 과제에 연결할 저장소 (하나)</legend>
            <label v-for="repo in status.pendingChoices" :key="repo.id" class="check">
              <input v-model="choice" type="radio" name="github-repo" :value="repo.id" />
              <span>{{ repo.fullName }} <span v-if="repo.private" class="muted">· 비공개</span></span>
            </label>
          </fieldset>
          <div class="actions">
            <button type="submit" :disabled="busy || choice === null">이 저장소 연결</button>
          </div>
        </form>
        <div v-else-if="status.canManage" class="actions">
          <button type="button" :disabled="busy" data-testid="github-install" @click="install">GitHub 연결</button>
        </div>
      </template>
    </template>
  </section>
</template>
