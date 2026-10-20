import { createPublicKillSwitch } from '../modules/publication/public-http'

/** 공개 조회 운영 스위치(PEERCHIVE_PUBLIC_READS_DISABLED=1이면 /api/v1/public/** 503, DB 접근 없음). ADR 0012. */
export default createPublicKillSwitch()
