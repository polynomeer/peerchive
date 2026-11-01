import { featureFlags } from '../../../modules/features'

/** GET /api/v1/features — P2 기능 플래그(영역별 켜짐 여부, ADR 0037). 로그인 없이. 화면이 진입점을 숨길 때 씁니다. */
export default defineApiHandler(() => ({ ...featureFlags() }))
