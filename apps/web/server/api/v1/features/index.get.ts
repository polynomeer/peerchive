import { featureFlags } from '../../../modules/features'
import { semanticStuckEnabled } from '../../../modules/course-hub/similar-stuck'
import { githubEnabled } from '../../../modules/github/config'
import { aiConfigured } from '../../../modules/ai/ai'

/**
 * GET /api/v1/features — P2 기능 플래그(영역별 켜짐 여부, ADR 0037). 로그인 없이. 화면이 진입점을 숨길 때 씁니다.
 * `semanticStuck`(E-05, ADR 0055)은 플래그가 아니라 임베딩 공급자가 설정되어 있는지, `github`(E-11, ADR 0056)는 GitHub App 설정 여섯 개가 모두 있는지,
 * `ai`(E-12, ADR 0057)는 AI 공급자(PEERCHIVE_AI_ENABLED=on + ANTHROPIC_API_KEY)가 설정되어 있는지입니다. AI 회고 인터뷰는 그 위에 학생이 과제마다 켜야 씁니다.
 */
export default defineApiHandler(() => ({ ...featureFlags(), semanticStuck: semanticStuckEnabled(), github: githubEnabled(), ai: aiConfigured() }))
