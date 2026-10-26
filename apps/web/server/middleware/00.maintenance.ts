import { createMaintenanceGate } from '../modules/ops/maintenance'

/** 점검 모드(PEERCHIVE_MAINTENANCE=1이면 /api/v1/health 밖 모든 요청 503, DB 접근 없음). 다른 미들웨어보다 먼저 실행됩니다. ADR 0016. */
export default createMaintenanceGate()
