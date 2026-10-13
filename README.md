# ProofU

ProofU는 대학교 학부 졸업작품으로 개발한 **팀 프로젝트 협업 서비스**입니다. 팀 구성과 가입 신청, 칸반 보드를 통한 작업 관리, 파일 공유와 팀 채팅을 한곳에서 다룰 수 있도록 만들었습니다. 프로젝트 검색과 개인 활동 조회, 학교 공지 연동 및 일정 화면도 포함합니다.

이 저장소는 졸업작품의 소스 코드와 예제 데이터, 배포 산출물을 보존하는 아카이브입니다. 현재 코드에는 누락 파일과 구버전 의존성 등 실행 제약이 있어, 설치 직후 정상 실행되는 상태는 아닙니다.

## 주요 기능

아래는 보존된 코드에 포함된 기능입니다. 현재 실행 검증을 마친 기능 목록을 의미하지는 않습니다.

| 기능 | 내용 |
|---|---|
| 계정 및 프로필 | JWT 로그인, 회원가입·프로필·비밀번호 변경 화면. 사용자 API 구현 파일은 현재 누락되어 있습니다. |
| 팀 관리 | 팀 생성·조회·수정, 가입 신청과 승인, 멤버 역할 및 관심 분야 관리 |
| 칸반 작업 관리 | 프로젝트 보드와 Todo/Doing/Done 리스트, 카드 생성·편집·삭제, 드래그를 통한 리스트·카드 순서 변경 |
| 파일 공유 | 보드와 카드에 파일 첨부, FilePond 기반 업로드 및 미리보기 화면 |
| 팀 채팅 | 팀별 채팅방, REST API를 통한 메시지 저장·조회, Socket.IO 변경 알림 |
| 검색 및 활동 조회 | 프로젝트 제목·설명 검색, 조회수 기반 목록, 개인 활동 타임라인과 언어·분야 차트 |
| 학교 공지 | 영남대학교 웹 페이지에서 공지를 수집해 표시하는 연동 코드 |
| 일정 화면 | DaySpan/Vuetify 기반 캘린더와 브라우저 저장 코드. 중복 옵션으로 일정 로직이 덮어써지는 문제가 있으며 서버 일정 API는 없습니다. |

## 기술 스택

현재 보존된 소스와 의존성 선언을 기준으로 정리했습니다. 이후 의존성 업데이트가 포함되어 있어 모두 2019년 당시 버전을 의미하지는 않습니다.

| 영역 | 기술 |
|---|---|
| 프론트엔드 | Vue 2, Vue Router 3, Vuex 3, Axios |
| UI 및 상호작용 | Dragula, FilePond/vue-filepond, Chart.js/vue-chartkick, DaySpan/Vuetify 연동 코드 |
| 빌드 | Webpack 3, Babel 6, webpack-dev-server |
| 백엔드 | Node.js, Express 4, Sequelize 6, MySQL |
| 인증 및 통신 | JSON Web Token, Socket.IO 2 |
| 공지 수집 | Axios, Cheerio |

SQLite 개발 DB 파일도 남아 있지만, 현재 서버의 활성 DB 설정은 MySQL입니다. Vuetify, DaySpan 및 아이콘 패키지 일부는 소스에서 사용하면서 직접 의존성 선언이 빠져 있습니다.

## 프로젝트 구조

```text
.
├── frontend/
│   ├── src/
│   │   ├── components/     # 팀·보드·카드·채팅·일정 등 Vue 화면
│   │   ├── api/            # Axios REST API 호출
│   │   ├── router/         # 화면 라우팅 및 인증 가드
│   │   ├── store/          # Vuex 상태·액션·뮤테이션
│   │   ├── assets/         # 이미지와 예제 데이터
│   │   ├── css/            # 공통 스타일
│   │   └── utils/          # 드래그 순서 계산 등
│   ├── dist/               # 보존된 배포 번들 및 source map
│   └── webpack.config.js
├── backend/
│   ├── api/                # 인증·팀·칸반·메시지·첨부·공지 API
│   ├── app.js              # Express 라우트 및 Socket.IO 연결
│   ├── index.js            # DB 동기화 및 HTTP 서버 시작
│   ├── models.js           # Sequelize 모델과 관계
│   ├── auth.js             # JWT 발급·검증
│   ├── public/             # 정적 HTML
│   ├── upload/             # 업로드 예제
│   └── db-dev.sqlite       # 보존된 개발 DB
├── docs/                   # 프로젝트 분석 및 이력 재구성 기록
├── scripts/check_archive.py
└── AGENTS.md               # Codex 작업 안내
```

일반적인 데이터 흐름은 Vue 화면 → Vuex → Axios → Express API → Sequelize/MySQL입니다. 채팅 메시지는 REST API로 저장하고, Socket.IO로 팀별 변경 알림을 전달합니다. HTTP API 기본 포트는 `3000`, Socket.IO 포트는 `10000`입니다.

## 현재 실행 제약

- **누락된 사용자 API:** `backend/app.js`에서 불러오는 `backend/api/user.js`가 없어 서버 시작이 차단됩니다.
- **의존성 및 런타임 호환성:** Vue/Webpack/Babel 구버전과 sqlite3 네이티브 모듈, Puppeteer 설치 동작이 포함되어 있습니다. 현재 Node.js 환경에서 설치·빌드·실행 호환성을 검증하지 않았으며, 프론트엔드 의존성 선언 보완도 필요합니다.
- **기존 구현 문제:** 캘린더의 중복 `data`·`mounted`·`methods`, 파일 업로드의 이중 응답 경로, Sequelize 업데이트 이후 남은 기존 API 사용 등을 확인해야 합니다.
- **설정 및 인증 보완:** MySQL 연결값과 JWT 키가 코드에 고정되어 있고 평문 비밀번호 비교·로그 및 일부 변경 API의 소유권 검증 누락이 남아 있습니다.
- **외부 연동 및 검증:** 학교 공지 수집은 기존 URL과 HTML 구조에 의존합니다. 현재 사이트와의 호환성은 확인하지 않았으며, 앱의 자동 테스트·CI도 구성되어 있지 않습니다.

기존 실행 진입점은 다음과 같습니다. 누락 파일과 호환성 문제를 해결하고 MySQL을 준비한 뒤 사용해야 합니다.

| 위치 | 명령 | 용도 |
|---|---|---|
| `frontend/` | `npm run dev` | 프론트엔드 개발 서버 |
| `frontend/` | `npm run build` | 배포 번들 생성 |
| `backend/` | `node index.js` | DB 동기화 및 서버 시작 |

이번 아카이브 정리에서는 원본 코드를 수정하거나 의존성을 설치하지 않았습니다. 상세한 제약과 실행 복원 순서는 [프로젝트 분석 문서](docs/PROJECT_ANALYSIS.md)를 참고하세요.

## 개발 이력과 백업

**2019년 6월~11월의 커밋 18개는 2020년에 업로드된 원본 코드를 기능별로 재구성한 기록입니다.** 날짜와 작업 순서는 임의로 배정했으며, 실제 당시 개발 로그를 복원한 것은 아닙니다. 각 커밋은 원본 파일을 단계적으로 보존하는 작업 단위로, 독립 실행 가능한 중간 버전을 의미하지 않습니다.

재구성 기록 뒤에는 기존 후속 커밋 103개(merge 55개 포함)를 연결했습니다. 기존 파일 내용과 커밋 메시지·작성자·날짜·merge 구조는 보존했으며, 부모 연결 변경으로 커밋 해시는 달라졌습니다.

2026-10-13에 재구성한 이력을 [원격 master](https://github.com/polynomeer/proofu-univ/tree/master)에 반영했습니다. 기존 이력은 로컬과 [원격 백업 브랜치 `backup/pre-reconstruction-20261013`](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013)에 유지되어 있습니다.

커밋별 파일 배정과 원본 이력 복구 방법은 [이력 재구성 문서](docs/HISTORY_RECONSTRUCTION.md)와 [커밋 대응표](docs/history-map.json)에 기록되어 있습니다.

## 아카이브 검증 및 참고 문서

저장소 루트에서 의존성 설치 없이 원본 파일 및 재구성 이력의 보존 여부를 검증할 수 있습니다.

```sh
python3 scripts/check_archive.py
```

이 검증은 파일과 Git 이력의 무결성을 확인하며, 앱의 빌드·실행 성공을 의미하지 않습니다.

- [프로젝트 분석](docs/PROJECT_ANALYSIS.md)
- [이력 재구성 및 복구 안내](docs/HISTORY_RECONSTRUCTION.md)
- [Codex 작업 안내](AGENTS.md)
