# 0001. 원본 아카이브 옆에 신규 앱을 만든다

- 상태: 채택
- 날짜: 2026-10-18

## 맥락

`frontend/`(Vue 2, Webpack 3)와 `backend/`(Express, Sequelize/MySQL)는 2019년 졸업작품 ProofU의 기록 보존 대상입니다. 누락 파일(`backend/api/user.js`), 구버전 빌드 체인, 평문 비밀번호·하드코딩된 비밀키 등으로 점진적 업그레이드 비용이 새로 만드는 비용과 비슷합니다(SYSTEM_DESIGN §2.1). 2019년 커밋은 실제 당시 로그가 아닌 기능별 재구성이며, `scripts/check_archive.py`가 원본 blob과 재구성 이력을 검증합니다.

## 결정

- 같은 저장소에 `apps/*`, `packages/*` pnpm 워크스페이스를 추가하고 원본 디렉터리는 워크스페이스에 넣지 않습니다.
- 원본 파일·lockfile·SQLite·업로드 예제·`docs/history-map.json`·`docs/archive-cleanup.json`은 수정하지 않습니다. 루트 `.gitignore`는 원본이 아니므로 신규 산출물 경로를 추가합니다.
- CI는 `archive`(원본 보존 검증)와 `app`(신규 앱 검증)을 별도 job으로 실행합니다.
- 신규 서비스는 원본과 DB·업로드 경로·비밀키·배포를 공유하지 않습니다.

## 결과

- 원본은 그대로 전시·참고 자료로 남고, 신규 코드는 현대적인 도구를 씁니다.
- 루트 `node_modules/`는 신규 워크스페이스 전용이며 원본 `frontend/`·`backend/`의 의존성 설치와 섞이지 않습니다.
- 원본 데이터를 신규 서비스로 옮길 때는 별도 importer(dry-run 우선)를 거칩니다(§15).

## 대안

- 원본을 Vue 3 / 최신 Express로 점진 업그레이드: 보존 원칙과 충돌하고 보안 구조 수정 비용이 큼.
- 별도 저장소: 이력·문서·검증 스크립트가 흩어지고 ProofU → Peerchive 연속성이 약해짐.
