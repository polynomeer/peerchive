/**
 * 시작 시 오브젝트 저장소를 확정합니다. production에서 허용되지 않은 driver(표시 없는 filesystem)면
 * 예외를 던져 서버가 뜨지 않게 합니다(메일 transport와 같은 방식).
 */
export default defineNitroPlugin(() => {
  useObjectStorage()
})
