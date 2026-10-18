# 0005. Node.js 런타임 버전 고정

- 상태: 채택
- 날짜: 2026-10-18

## 맥락

SYSTEM_DESIGN §4는 구현 시작 시 지원 중인 Node LTS와 라이브러리 조합을 확인해 lockfile·런타임·CI를 함께 고정하도록 합니다. 2026-10 기준 Node 24가 Active LTS, Node 22가 Maintenance LTS이며, 개발 장비의 로컬 Node는 23.10(홀수, 비 LTS)입니다. Nuxt 4.5는 `^22.19.0 || ^24.11.0 || >=26`을 지원합니다.

## 결정

- `.nvmrc`는 `24`(Active LTS), CI는 `.nvmrc`를 읽어 같은 버전을 씁니다.
- 루트 `package.json`의 `engines.node`는 `^22.19.0 || ^24.11.0`(지원 중인 LTS 두 라인)입니다.
- 패키지 관리자는 `packageManager: pnpm@11.28.2`로 고정합니다.
- 의존성은 정확한 버전으로 고정하고, `pnpm-workspace.yaml`의 `minimumReleaseAge: 20160`(14일)으로 공개된 지 2주가 안 된 버전(전이 의존성 포함)은 설치하지 않습니다. 설치 스크립트는 `allowBuilds` 허용 목록(현재 `esbuild`)만 실행합니다.

## 결과

- 로컬 Node 23에서는 pnpm이 `Unsupported engine` 경고를 내지만 설치·타입 검사·테스트·빌드는 통과했습니다(Phase 0 확인). 기준 환경은 CI의 Node 24이며, 로컬도 `nvm use` 등으로 24를 쓰는 것을 권장합니다.
- Node 26이 LTS가 되면(2026-10 말 예정) 새 ADR로 전환을 검토합니다.

## 대안

- 로컬 버전(23)에 맞춤: 비 LTS라 보안 지원이 짧고 Nuxt 공식 지원 범위 밖.
- Node 22 고정: 지원은 되지만 Maintenance 단계라 남은 지원 기간이 짧음.
