/**
 * 시작 시 신뢰 프록시 설정을 확인합니다. production에서 잘못된 CIDR이 있으면 서버가 뜨지 않게 합니다
 * (오타로 X-Forwarded-For를 잘못 믿거나 모든 요청이 프록시 IP 하나로 묶이는 것 방지).
 */
export default defineNitroPlugin(() => {
  useTrustedProxies()
})
