import { featureFlags } from '../../../modules/features'
import { semanticStuckEnabled } from '../../../modules/course-hub/similar-stuck'
import { githubEnabled } from '../../../modules/github/config'

/**
 * GET /api/v1/features — P2 기능 플래그(영역별 켜짐 여부, ADR 0037). 로그인 없이. 화면이 진입점을 숨길 때 씁니다.
 * `semanticStuck`(E-05, ADR 0055)은 플래그가 아니라 임베딩 공급자가 설정되어 있는지, `github`(E-11, ADR 0056)는 GitHub App 설정 여섯 개가 모두 있는지입니다.
 */
export default defineApiHandler(() => ({ ...featureFlags(), semanticStuck: semanticStuckEnabled(), github: githubEnabled() }))
