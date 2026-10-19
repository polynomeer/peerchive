/**
 * 시작 시 메일 transport를 확정합니다. production에서 개발용(dev-console) transport면
 * 예외를 던져 서버가 뜨지 않게 합니다(로그인 링크가 로그로 새는 것 방지).
 */
export default defineNitroPlugin(() => {
  useMailTransport()
})
