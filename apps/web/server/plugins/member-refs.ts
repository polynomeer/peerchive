import { memberRefConfigProblems } from '../modules/projects/member-refs'

/**
 * 시작 시 익명 스터디 기록의 멤버 가명 키 pepper를 확인합니다(ADR 0026 부록). production에서 PEERCHIVE_MEMBER_REF_PEPPER가
 * 없거나 약하면 서버가 뜨지 않게 합니다(가명 키를 만들 수 없으면 익명 기록 응답을 줄 수 없음).
 */
export default defineNitroPlugin(() => {
  const problems = memberRefConfigProblems()
  if (problems.length > 0) throw new Error(`[member-refs] ${problems.join('; ')}`)
})
