import { affiliationConfig } from '../modules/affiliation/config'

/**
 * 시작 시 학교 메일 인증 설정을 확인합니다(C-01, ADR 0018). production에서 HMAC pepper가 없거나 약하거나,
 * 과목 허브 작성 정책을 끄면(PEERCHIVE_HUB_REQUIRE_AFFILIATION=0) 서버가 뜨지 않게 합니다.
 */
export default defineNitroPlugin(() => {
  const { problems } = affiliationConfig()
  if (problems.length > 0) throw new Error(`[affiliation] ${problems.join('; ')}`)
})
