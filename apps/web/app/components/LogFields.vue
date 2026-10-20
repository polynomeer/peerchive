<script setup lang="ts">
/**
 * 빌드 로그 입력 필드. 작성 폼과 수정 폼이 함께 씁니다.
 * 고른 태그에 해당하는 구조화 필드만 보여 주며, form 객체(reactive)를 그대로 고칩니다.
 * 사후 작성 모드에서는 날짜 칸을 맨 위로 올리고 "기억·파일 기준 날짜(자기 기입)"로 부릅니다(T-07, 시나리오 G).
 */
import type { LogDto, MemberDto, MilestoneDto, TimeBucket } from '~~/shared/types/api'
import type { LogForm } from '~/utils/build-log'
import type { EvidenceOption } from '~/utils/artifacts'

const props = defineProps<{
  form: LogForm
  idPrefix: string
  errors: Record<string, string>
  members: MemberDto[]
  /** 💡해결이 연결할 수 있는 이 과제의 🧱막힘 로그. */
  stuckLogs: LogDto[]
  /** 이 과제의 산출물 버전(파일 근거 후보). */
  evidenceOptions: EvidenceOption[]
  /** 이 과제의 마일스톤(순서대로, T-06). */
  milestones: MilestoneDto[]
  /** 사후 작성 모드(T-07): 수행일을 "기억·파일 기준 날짜"로 이름 붙이고 맨 위에 둡니다. */
  retro?: boolean
}>()

const id = (name: string) => `${props.idPrefix}-${name}`
const err = (name: string) => fieldMessage(props.errors[name])
const invalid = (name: string) => (props.errors[name] ? 'true' : undefined)
const describedBy = (name: string, hint = false) =>
  [hint ? id(`${name}-hint`) : '', props.errors[name] ? id(`${name}-error`) : ''].filter(Boolean).join(' ') || undefined

const TIME_BUCKETS = Object.keys(TIME_BUCKET_LABELS) as TimeBucket[]

/**
 * 근거로 고를 수 있는 버전: 사용 가능·검사 대기·검사 중. 이미 붙어 있던 버전은 상태와 무관하게 보여 줘서 뺄 수 있게 합니다.
 * 격리·실패 버전은 새로 붙일 수 없습니다(서버도 422).
 */
const evidenceChoices = computed(() =>
  props.evidenceOptions.filter(
    (option) =>
      option.scanStatus === 'clean' || isScanInProgress(option.scanStatus) || props.form.evidenceVersionIds.includes(option.versionId),
  ),
)
const evidenceDisabled = (option: EvidenceOption) =>
  !props.form.evidenceVersionIds.includes(option.versionId) &&
  (props.form.evidenceVersionIds.length >= 10 || option.scanStatus === 'quarantined' || option.scanStatus === 'failed')
const bodyRequired = computed(() => props.form.tag === 'progress' || props.form.tag === 'retro')
const bodyPlaceholder = computed(() =>
  props.form.tag === 'retro'
    ? '배운 점 / 다시 한다면 / 근거'
    : '한 일: …\n알게 된 점: …\n근거: (아래 링크 칸에 PR·문서 주소를 붙이세요)',
)
</script>

<template>
  <div class="stack">
    <div v-if="retro" class="field retro-date">
      <label :for="id('claimedDate')">기억·파일 기준 날짜(자기 기입)</label>
      <input :id="id('claimedDate')" v-model="form.claimedDate" type="date" :aria-invalid="invalid('claimedDate')" :aria-describedby="describedBy('claimedDate', true)" />
      <p :id="id('claimedDate-hint')" class="hint">
        파일 수정일·커밋 이력·발표 자료 버전을 보고 그 일이 있었던 날을 적으세요. 스스로 적는 날짜이며, 오늘 기록한 시각은 서버가 따로 남깁니다.
      </p>
      <p v-if="err('claimedDate')" :id="id('claimedDate-error')" class="field-error">{{ err('claimedDate') }}</p>
    </div>

    <!-- 🧱 막힘 -->
    <template v-if="form.tag === 'stuck'">
      <div class="field">
        <label :for="id('symptom')">증상 (필수)</label>
        <input :id="id('symptom')" v-model="form.symptom" maxlength="200" :aria-invalid="invalid('symptom')" :aria-describedby="describedBy('symptom')" placeholder="예: 로그인 요청에서 CORS 에러" />
        <p v-if="err('symptom')" :id="id('symptom-error')" class="field-error">{{ err('symptom') }}</p>
      </div>
      <div class="field">
        <label :for="id('keywords')">맥락 키워드 (쉼표로 구분, 최대 10개)</label>
        <input :id="id('keywords')" v-model="form.keywords" :aria-invalid="invalid('keywords')" :aria-describedby="describedBy('keywords')" placeholder="cors, proxy, express" />
        <p v-if="err('keywords')" :id="id('keywords-error')" class="field-error">{{ err('keywords') }}</p>
      </div>
      <div class="field">
        <label :for="id('errorText')">오류 메시지 (선택)</label>
        <textarea :id="id('errorText')" v-model="form.errorText" maxlength="2000" class="mono" :aria-invalid="invalid('errorText')" :aria-describedby="describedBy('errorText')" />
        <p v-if="err('errorText')" :id="id('errorText-error')" class="field-error">{{ err('errorText') }}</p>
      </div>
      <div class="field">
        <label :for="id('attempts')">시도한 것 (한 줄에 하나)</label>
        <textarea :id="id('attempts')" v-model="form.attempts" :aria-invalid="invalid('attempts')" :aria-describedby="describedBy('attempts')" placeholder="프록시 설정 → 실패" />
        <p v-if="err('attempts')" :id="id('attempts-error')" class="field-error">{{ err('attempts') }}</p>
      </div>
    </template>

    <!-- 💡 해결 -->
    <template v-if="form.tag === 'solution'">
      <div class="field">
        <label :for="id('resolvesEntryId')">해결한 막힘 (필수)</label>
        <select :id="id('resolvesEntryId')" v-model="form.resolvesEntryId" :aria-invalid="invalid('resolvesEntryId')" :aria-describedby="describedBy('resolvesEntryId', true)">
          <option value="" disabled>막힘 로그를 고르세요</option>
          <option v-for="log in stuckLogs" :key="log.id" :value="log.id">
            {{ (log.payload as { symptom?: string }).symptom || '증상 없음' }} — {{ log.author.displayName }}{{ log.resolvedBy.length > 0 ? ' (해결됨)' : ' (미해결)' }}
          </option>
        </select>
        <p :id="id('resolvesEntryId-hint')" class="hint">한 막힘에 해결을 여러 개 연결할 수 있습니다. 목록에는 최근 막힘 50개가 보입니다.</p>
        <p v-if="err('resolvesEntryId')" :id="id('resolvesEntryId-error')" class="field-error">{{ err('resolvesEntryId') }}</p>
      </div>
      <div class="field">
        <label :for="id('method')">해결 방법 (필수)</label>
        <textarea :id="id('method')" v-model="form.method" maxlength="2000" :aria-invalid="invalid('method')" :aria-describedby="describedBy('method', true)" />
        <p :id="id('method-hint')" class="hint">정답 코드 대신 개념·접근을 적어 주세요.</p>
        <p v-if="err('method')" :id="id('method-error')" class="field-error">{{ err('method') }}</p>
      </div>
    </template>

    <div v-if="form.tag === 'stuck' || form.tag === 'solution'" class="field">
      <label :for="id('timeBucket')">걸린 시간{{ form.tag === 'stuck' ? ' (필수)' : ' (선택)' }}</label>
      <select :id="id('timeBucket')" v-model="form.timeBucket" :aria-invalid="invalid('timeBucket')" :aria-describedby="describedBy('timeBucket')">
        <option value="">{{ form.tag === 'stuck' ? '고르세요' : '적지 않음' }}</option>
        <option v-for="b in TIME_BUCKETS" :key="b" :value="b">{{ TIME_BUCKET_LABELS[b] }}</option>
      </select>
      <p v-if="err('timeBucket')" :id="id('timeBucket-error')" class="field-error">{{ err('timeBucket') }}</p>
    </div>

    <!-- ⚖️ 결정 -->
    <template v-if="form.tag === 'decision'">
      <div class="field">
        <label :for="id('options')">선택지 (한 줄에 하나, 2~6개)</label>
        <textarea :id="id('options')" v-model="form.options" :aria-invalid="invalid('options')" :aria-describedby="describedBy('options')" placeholder="MySQL&#10;Firebase" />
        <p v-if="err('options')" :id="id('options-error')" class="field-error">{{ err('options') }}</p>
      </div>
      <div class="field">
        <label :for="id('criteria')">판단 기준 (필수)</label>
        <textarea :id="id('criteria')" v-model="form.criteria" maxlength="1000" :aria-invalid="invalid('criteria')" :aria-describedby="describedBy('criteria')" />
        <p v-if="err('criteria')" :id="id('criteria-error')" class="field-error">{{ err('criteria') }}</p>
      </div>
      <div class="field">
        <label :for="id('choice')">선택 (필수)</label>
        <input :id="id('choice')" v-model="form.choice" maxlength="200" :aria-invalid="invalid('choice')" :aria-describedby="describedBy('choice')" />
        <p v-if="err('choice')" :id="id('choice-error')" class="field-error">{{ err('choice') }}</p>
      </div>
      <div class="field">
        <label :for="id('hindsight')">지나고 보니 (선택)</label>
        <textarea :id="id('hindsight')" v-model="form.hindsight" maxlength="2000" :aria-invalid="invalid('hindsight')" :aria-describedby="describedBy('hindsight')" />
        <p v-if="err('hindsight')" :id="id('hindsight-error')" class="field-error">{{ err('hindsight') }}</p>
      </div>
    </template>

    <!-- ✅ 검증 -->
    <template v-if="form.tag === 'validation'">
      <div v-for="[name, label] in ([['target', '대상 (필수)'], ['conditions', '조건 (필수)'], ['result', '결과 (필수)'], ['openQuestions', '남은 불확실성 (선택)']] as const)" :key="name" class="field">
        <label :for="id(name)">{{ label }}</label>
        <textarea :id="id(name)" v-model="form[name]" maxlength="1000" :aria-invalid="invalid(name)" :aria-describedby="describedBy(name)" />
        <p v-if="err(name)" :id="id(`${name}-error`)" class="field-error">{{ err(name) }}</p>
      </div>
    </template>

    <!-- 🗣️ 회의 -->
    <template v-if="form.tag === 'meeting'">
      <fieldset :aria-describedby="describedBy('attendees')">
        <legend>참석자</legend>
        <div class="inline-options">
          <label v-for="m in members" :key="m.userId">
            <input v-model="form.attendees" type="checkbox" :value="m.userId" />
            {{ m.displayName || m.handle || '이름 미설정' }}
          </label>
        </div>
        <p v-if="err('attendees')" :id="id('attendees-error')" class="field-error">{{ err('attendees') }}</p>
      </fieldset>
      <div class="field">
        <label :for="id('decisions')">결정 사항 (한 줄에 하나)</label>
        <textarea :id="id('decisions')" v-model="form.decisions" :aria-invalid="invalid('decisions')" :aria-describedby="describedBy('decisions')" />
        <p v-if="err('decisions')" :id="id('decisions-error')" class="field-error">{{ err('decisions') }}</p>
      </div>
      <div class="field">
        <label :for="id('followUps')">후속 할 일 (한 줄에 하나)</label>
        <textarea :id="id('followUps')" v-model="form.followUps" :aria-invalid="invalid('followUps')" :aria-describedby="describedBy('followUps')" />
        <p v-if="err('followUps')" :id="id('followUps-error')" class="field-error">{{ err('followUps') }}</p>
      </div>
    </template>

    <div class="field">
      <label :for="id('body')">{{ bodyRequired ? '내용 (필수)' : '메모 (선택)' }}</label>
      <textarea :id="id('body')" v-model="form.body" maxlength="5000" :placeholder="bodyPlaceholder" :aria-invalid="invalid('body')" :aria-describedby="describedBy('body', true)" />
      <p :id="id('body-hint')" class="hint">1~5줄이면 충분합니다. {{ form.body.length }}/5000자</p>
      <p v-if="err('body')" :id="id('body-error')" class="field-error">{{ err('body') }}</p>
    </div>

    <div class="field">
      <label :for="id('links')">근거 링크 (선택, 한 줄에 하나: 주소 뒤에 제목)</label>
      <textarea :id="id('links')" v-model="form.links" class="mono" :aria-invalid="invalid('links')" :aria-describedby="describedBy('links', true)" placeholder="https://github.com/team/repo/pull/12 로그인 PR" />
      <p :id="id('links-hint')" class="hint">http·https 주소만, 최대 10개. 링크는 저장만 하고 미리 열어 보지 않습니다.</p>
      <p v-if="err('links')" :id="id('links-error')" class="field-error">{{ err('links') }}</p>
    </div>

    <fieldset v-if="evidenceChoices.length" :aria-describedby="[id('evidence-hint'), props.errors.evidenceVersionIds ? id('evidence-error') : ''].filter(Boolean).join(' ')">
      <legend>파일 근거 (선택, 최대 10개)</legend>
      <div class="inline-options evidence-options">
        <label v-for="option in evidenceChoices" :key="option.versionId">
          <input v-model="form.evidenceVersionIds" type="checkbox" :value="option.versionId" :disabled="evidenceDisabled(option)" />
          {{ option.label }} — {{ SCAN_STATUS_LABELS[option.scanStatus] }}
        </label>
      </div>
      <p :id="id('evidence-hint')" class="hint">위 산출물에 올린 파일을 고릅니다. 검사 중인 파일도 붙일 수 있으며 "검사 중"으로 표시됩니다.</p>
      <p v-if="err('evidenceVersionIds')" :id="id('evidence-error')" class="field-error">{{ err('evidenceVersionIds') }}</p>
    </fieldset>

    <div v-if="milestones.length || form.milestoneId" class="field">
      <label :for="id('milestoneId')">마일스톤 (선택)</label>
      <select :id="id('milestoneId')" v-model="form.milestoneId" :aria-invalid="invalid('milestoneId')" :aria-describedby="describedBy('milestoneId')">
        <option value="">마일스톤 없음</option>
        <option v-for="m in milestones" :key="m.id" :value="m.id">{{ milestoneLabel(m) }}</option>
      </select>
      <p v-if="err('milestoneId')" :id="id('milestoneId-error')" class="field-error">{{ err('milestoneId') }}</p>
    </div>

    <div v-if="!retro" class="field">
      <label :for="id('claimedDate')">실제 수행일 (선택, 자기 기입)</label>
      <input :id="id('claimedDate')" v-model="form.claimedDate" type="date" :aria-invalid="invalid('claimedDate')" :aria-describedby="describedBy('claimedDate', true)" />
      <p :id="id('claimedDate-hint')" class="hint">비워 두면 기록 시각만 남습니다. 기록 시각은 서버가 따로 저장합니다.</p>
      <p v-if="err('claimedDate')" :id="id('claimedDate-error')" class="field-error">{{ err('claimedDate') }}</p>
    </div>

    <label v-if="form.tag === 'stuck'" class="check">
      <input v-model="form.answerCheck" type="checkbox" />
      적은 내용이 과제 답 자체가 아님을 확인했습니다. (정답 코드에 가깝다면 개념·접근 설명으로 바꿔 주세요.)
    </label>
    <div v-if="form.tag === 'solution'" class="field">
      <label class="check">
        <input v-model="form.notAnswerConfirmed" type="checkbox" :aria-invalid="invalid('notAnswerConfirmed')" :aria-describedby="describedBy('notAnswerConfirmed')" />
        해결 부분이 과제 답 자체가 아님을 확인했습니다. (필수)
      </label>
      <p v-if="err('notAnswerConfirmed')" :id="id('notAnswerConfirmed-error')" class="field-error">{{ err('notAnswerConfirmed') }}</p>
    </div>
  </div>
</template>
