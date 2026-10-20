<script setup lang="ts">
/**
 * 과제 공간의 산출물(T-05): 파일 올리기(진행률·상태 문구), 산출물·버전 목록, 새 버전, 검사 통과 이미지 미리보기·PDF 내려받기.
 *
 * - 업로드는 의도 → PUT → 완료 3단계이며, 실패하면 같은 clientId로 다시 시도해 중복 산출물이 생기지 않게 합니다.
 * - 검사 대기·검사 중인 버전이 있으면 3초마다 목록을 다시 불러옵니다(최대 10분).
 * - 상태는 텍스트로 보여 줍니다: 업로드 중 / 검사 대기 / 검사 중 / 사용 가능 / 격리됨: 사유 / 검사 실패(다시 시도).
 */
import type { ArtifactDto, ArtifactVersionDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; canWrite: boolean }>()
const { items, loaded, loadError, refresh, replace } = useProjectArtifacts(props.projectId)

// ── 업로드 진행 상태 ──
interface UploadTask {
  key: string
  file: File
  clientId: string
  artifactId?: string
  /** 새 버전이면 대상 산출물 이름. */
  target?: string
  progress: number
  error: string | null
}
const uploads = ref<UploadTask[]>([])
const pickError = ref<string | null>(null)

function startUpload(file: File, artifact?: ArtifactDto) {
  pickError.value = null
  const problem = precheckFile(file)
  if (problem) {
    pickError.value = `${file.name}: ${problem}`
    return
  }
  const task: UploadTask = {
    key: newClientId(),
    file,
    clientId: newClientId(),
    ...(artifact && { artifactId: artifact.id, target: artifact.title }),
    progress: 0,
    error: null,
  }
  uploads.value = [...uploads.value, task]
  void runUpload(task.key)
}

function patchTask(key: string, patch: Partial<UploadTask>) {
  uploads.value = uploads.value.map((task) => (task.key === key ? { ...task, ...patch } : task))
}

async function runUpload(key: string) {
  const task = uploads.value.find((t) => t.key === key)
  if (!task) return
  patchTask(key, { error: null, progress: 0 })
  try {
    const result = await uploadArtifactFile(props.projectId, task.file, {
      clientId: task.clientId,
      ...(task.artifactId && { artifactId: task.artifactId }),
      onProgress: (ratio) => patchTask(key, { progress: Math.round(ratio * 100) }),
    })
    replace(result.artifact)
    uploads.value = uploads.value.filter((t) => t.key !== key)
    schedulePoll()
  } catch (e) {
    patchTask(key, {
      error: e instanceof UploadError ? e.userMessage : '업로드하지 못했습니다. 다시 시도하세요.',
      // 의도가 만료됐으면 다음 시도는 새 의도로 합니다(같은 clientId는 만료된 의도를 돌려줌).
      ...(e instanceof UploadError && e.code === 'intent_expired' && { clientId: newClientId() }),
    })
  }
}

function dismissTask(key: string) {
  uploads.value = uploads.value.filter((t) => t.key !== key)
}

function onPick(event: Event, artifact?: ArtifactDto) {
  const input = event.target as HTMLInputElement
  for (const file of Array.from(input.files ?? [])) startUpload(file, artifact)
  input.value = ''
}

// ── 검사 상태 갱신 ──
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollUntil = 0
const hasPending = computed(() => items.value.some((a) => a.versions.some((v) => isScanInProgress(v.scanStatus))))

function schedulePoll() {
  pollUntil = Date.now() + 10 * 60 * 1000
  if (pollTimer) return
  const tick = async () => {
    pollTimer = null
    await refresh()
    if (hasPending.value && Date.now() < pollUntil) pollTimer = setTimeout(tick, 3000)
  }
  pollTimer = setTimeout(tick, 3000)
}

const rescanError = ref<string | null>(null)
async function rescan(artifact: ArtifactDto, version: ArtifactVersionDto) {
  rescanError.value = null
  try {
    replace(await $fetch<ArtifactDto>(`/api/v1/artifacts/${artifact.id}/versions/${version.id}/rescan`, { method: 'POST' }))
    schedulePoll()
  } catch {
    rescanError.value = `${artifact.title} v${version.versionNo}: 다시 검사를 요청하지 못했습니다.`
  }
}

const isImage = (version: ArtifactVersionDto) => !!version.mediaType?.startsWith('image/')
const versionLine = (version: ArtifactVersionDto) =>
  `v${version.versionNo} · ${version.fileName} · ${formatBytes(version.bytes)} · ${version.uploader.displayName || version.uploader.handle || '이름 미설정'} · ${formatDateTime(version.createdAt)}`

onMounted(async () => {
  await refresh()
  if (hasPending.value) schedulePoll()
})
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer)
})
</script>

<template>
  <section class="card" aria-labelledby="artifacts-heading">
    <h2 id="artifacts-heading">산출물</h2>
    <p id="artifact-limits" class="hint">
      허용 형식: {{ ALLOWED_UPLOAD_LABEL }} · 파일당 최대 {{ formatBytes(MAX_UPLOAD_BYTES) }} · 1인당 500MB.
      올린 파일은 형식·악성코드 검사를 통과해야 열 수 있습니다.
    </p>

    <div v-if="canWrite" class="field">
      <label for="artifact-file">새 산출물 올리기</label>
      <input id="artifact-file" type="file" multiple :accept="UPLOAD_ACCEPT" aria-describedby="artifact-limits" @change="onPick($event)" />
    </div>
    <p v-else class="hint">이 과제의 산출물을 볼 수 있지만 올릴 수는 없습니다(편집자 이상만 업로드).</p>
    <p v-if="pickError" class="field-error" role="alert">{{ pickError }}</p>

    <ul v-if="uploads.length" class="plain uploads" aria-label="올리는 중인 파일">
      <li v-for="task in uploads" :key="task.key" class="upload-task">
        <span>{{ task.file.name }}<template v-if="task.target"> → {{ task.target }} 새 버전</template></span>
        <template v-if="!task.error">
          <span role="status">업로드 중 ({{ task.progress }}%)</span>
          <progress max="100" :value="task.progress" :aria-label="`${task.file.name} 업로드 진행률`" />
        </template>
        <template v-else>
          <span class="field-error" role="alert">업로드 실패: {{ task.error }}</span>
          <span class="actions">
            <button type="button" class="secondary" @click="runUpload(task.key)">다시 시도</button>
            <button type="button" class="link-button" @click="dismissTask(task.key)">닫기</button>
          </span>
        </template>
      </li>
    </ul>

    <p v-if="loadError" class="notice error" role="alert">
      산출물을 불러오지 못했습니다. <button type="button" class="link-button" @click="refresh">다시 시도</button>
    </p>
    <p v-else-if="loaded && items.length === 0" class="muted">아직 산출물이 없습니다.</p>
    <p v-if="rescanError" class="field-error" role="alert">{{ rescanError }}</p>

    <ol class="plain artifact-list" aria-label="산출물 목록 (최신순)">
      <li v-for="artifact in items" :key="artifact.id">
        <article class="artifact-item" :aria-labelledby="`artifact-${artifact.id}`">
          <header class="log-head">
            <h3 :id="`artifact-${artifact.id}`" class="log-tag">📎 {{ artifact.title }}</h3>
            <span v-if="artifact.latestVersion" :class="['badge', `scan-${artifact.latestVersion.scanStatus}`]">
              최신 v{{ artifact.latestVersion.versionNo }}: {{ SCAN_STATUS_LABELS[artifact.latestVersion.scanStatus] }}
            </span>
          </header>

          <ol class="plain versions" :aria-label="`${artifact.title} 버전`">
            <li v-for="version in artifact.versions" :key="version.id" class="version">
              <p class="small">
                {{ versionLine(version) }} ·
                <strong>{{ scanStatusText(version.scanStatus, version.scanReason) }}</strong>
                <span v-if="isScanInProgress(version.scanStatus)" class="muted"> (자동으로 갱신됩니다)</span>
                <template v-if="metadataLabel(version)"> · <span class="muted">{{ metadataLabel(version) }}</span></template>
              </p>
              <button
                v-if="version.scanStatus === 'failed' && artifact.canUpload"
                type="button"
                class="secondary"
                @click="rescan(artifact, version)"
              >
                다시 시도
              </button>
              <template v-if="version.contentUrl">
                <a v-if="isImage(version)" :href="version.contentUrl" target="_blank" rel="noopener">
                  <img :src="version.contentUrl" :alt="`${artifact.title} v${version.versionNo} 미리보기`" class="preview" loading="lazy" />
                </a>
                <a v-else :href="version.contentUrl" download>PDF 내려받기 (v{{ version.versionNo }})</a>
              </template>
            </li>
          </ol>

          <label v-if="artifact.canUpload" class="file-button">
            새 버전 올리기
            <input type="file" class="visually-hidden" :accept="UPLOAD_ACCEPT" @change="onPick($event, artifact)" />
          </label>
        </article>
      </li>
    </ol>
  </section>
</template>
