# ProofU 작업 안내

대학교 졸업작품의 원본을 보존하는 Vue 2 / Express 프로젝트입니다.
- frontend/: Vue 단일 파일 컴포넌트, Vuex, Vue Router, Webpack 3.
- backend/: Express REST API, Sequelize/MySQL, Socket.IO.
- 원본 코드와 lockfile, SQLite, 업로드 예제, 배포 산출물은 기록 보존 대상입니다. 요청 없이 현대화하거나 삭제하지 마세요.
- 먼저 docs/PROJECT_ANALYSIS.md와 docs/HISTORY_RECONSTRUCTION.md를 읽으세요.
- 설치 없이 `python3 scripts/check_archive.py`로 아카이브를 점검할 수 있습니다.
- 실행은 frontend에서 npm run dev, backend에서 node index.js입니다. 현재 누락 파일과 구버전 의존성 때문에 정상 실행을 전제하지 마세요.
- 원격 push와 추가 이력 재작성은 사용자가 요청한 범위에서만 진행하세요.
- 2019년 커밋은 실제 당시 로그가 아니라 기능별 아카이브 재구성입니다. 이 사실을 유지하세요.
