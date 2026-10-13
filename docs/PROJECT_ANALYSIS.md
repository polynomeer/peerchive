# ProofU 프로젝트 분석

## 구조와 데이터 흐름

Vue 2 → Vue Router의 인증 가드 → Vuex action → Axios REST API → Express → Sequelize/MySQL 흐름입니다.
로그인 토큰은 localStorage와 Axios Authorization 헤더에 저장됩니다. Socket.IO는 팀별 방에 가입하고 변경 알림을 전달하며, 메시지 본문은 REST API로 저장·조회합니다.
HTTP API 기본 포트는 3000, Socket.IO 포트는 10000입니다. frontend 개발 서버는 Webpack 설정을 사용합니다.

## 기능별 분석

| 영역 | 파일 및 동작 |
|---|---|
| 서버 시작 | backend/index.js는 DB sync 이후 HTTP 서버를 시작. app.js는 미들웨어·라우트·Socket.IO 서버를 연결 |
| 데이터 모델 | models.js: User, Team, Member, Join, Board, List, Card, Message, BoardFile, CardFile. 팀-멤버·가입요청·게시판, 게시판-리스트-카드와 파일 관계 |
| 인증·계정 | auth.js의 JWT, api/auth.js 로그인. Login/SignUp/Profile/ChangePW/UserInfo 화면. 사용자 CRUD 라우트의 구현 파일은 누락 |
| 팀 | api/team/member/join의 팀 조회·생성·수정, 멤버 역할·분야 관리, 가입 신청·승인. Team/TeamBox/AddTeam 화면 |
| 칸반 | api/board/list/card의 생성·편집·삭제. 기본 Todo/Doing/Done 리스트. pos 값으로 정렬. Board/List/Card 및 Add* 화면과 dragger.js로 드래그 순서 갱신 |
| 검색·대시보드 | 제목·설명 LIKE 검색, 조회수 정렬. Home/Search/SearchBox, MyPage의 활동 타임라인·언어/분야 차트 |
| 파일 | boardfile/cardfile API와 FilePond 업로드. Code는 게시판 첨부, Card/CardItem은 카드 첨부. 업로드 예제도 보존 |
| 채팅 | Chat.vue, message API, Vuex socket 상태. 팀별 join/leave/chat 알림과 REST 메시지 목록 |
| 일정 | Calendar/CalendarModal, DaySpan/Vuetify. localStorage의 dayspanState를 사용하는 코드가 있으나 중복 옵션으로 앞선 구현이 덮어써짐. 서버 일정 모델/API는 없음 |
| 학교 공지 | html API가 영남대학교 HTML을 Axios/Cheerio로 수집. YUnotice에 공지와 팀 목록 표시 |
| 공통 UI | App/Navbar/Left/NotFound, 공통 Modal 및 Card/Code/Calendar 모달, main.css와 이미지/SVG |
| 상태·라우팅 | state/getters/mutations/actions, API facade, 토큰 복원, 보호된 화면 및 게시판 하위 카드 라우트 |
| 배포·예제 | frontend/dist 번들·source map, backend/public HTML, SQLite DB, 업로드 예제, node-gyp config, *_bk.vue 변형을 원본 그대로 보존 |

## 실행과 유지보수 제약

- backend/app.js가 요구하는 `backend/api/user.js`가 없습니다. 의존성 설치만으로 서버를 실행할 수 없습니다.
- frontend/main.js의 Vuetify와 아이콘 CSS, Calendar.vue의 dayspan은 직접 의존성 선언이 없습니다. 전이 의존성 존재 여부와 별개로 의존성 선언을 정리할 필요가 있습니다.
- Calendar.vue의 data/mounted/methods 중복 선언은 뒤쪽 값이 앞쪽 일정 로직을 덮어씁니다. description 바인딩도 확인이 필요합니다.
- MySQL 연결값과 JWT 키가 코드에 고정되어 있고 로그인은 평문 비밀번호를 비교·로그합니다. 여러 변경/삭제 라우트는 사용자 소유권 검사 없이 동작합니다.
- 파일 업로드 콜백과 함수 끝에서 응답을 각각 보내는 경로가 있어 이중 응답 문제가 발생할 수 있습니다. 파일 삭제 API는 DB 기록만 삭제합니다.
- Sequelize 의존성이 원본 이후 6.x로 변경되었으나 list.destroy의 Promise.map 형태 등 기존 API 사용이 남아 있습니다.
- Vue/Webpack/Babel 구버전, sqlite3 네이티브 모듈과 Puppeteer 설치 동작을 포함합니다. 현재 Node 23 환경에서 호환성을 검증한 상태가 아닙니다.
- 기존 자동 테스트·CI·Babel 설정 파일이 없습니다. 이번 기록 작업에서는 의존성 설치, 외부 학교 사이트 호출, DB 변경, 원본 동작 수정은 수행하지 않았습니다.

실행 복원을 별도로 진행한다면 누락 사용자 API 복구 → 런타임/의존성 호환 확인 → 설정 외부화 → REST·채팅·첨부·일정 기능 검증 순서가 적절합니다.

## 전체 파일 목록

아래는 기존 HEAD의 모든 추적 파일을 조사한 목록입니다. 텍스트 소스는 기능·import·상태 흐름을 확인했고, lockfile은 JSON 구조 및 버전, 바이너리는 형식·크기, 배포 산출물은 보존 대상으로 확인했습니다. 번들 내부의 타사 코드를 개별 감사한 것은 아닙니다.

| 파일 | 바이트 | 유형 |
|---|---:|---|
| `README.md` | 668 | 원본 텍스트/설정 |
| `backend/api/auth.js` | 529 | 원본 텍스트/설정 |
| `backend/api/board.js` | 3790 | 원본 텍스트/설정 |
| `backend/api/boardfile.js` | 796 | 원본 텍스트/설정 |
| `backend/api/card.js` | 1418 | 원본 텍스트/설정 |
| `backend/api/cardfile.js` | 786 | 원본 텍스트/설정 |
| `backend/api/html.js` | 798 | 원본 텍스트/설정 |
| `backend/api/join.js` | 684 | 원본 텍스트/설정 |
| `backend/api/list.js` | 1696 | 원본 텍스트/설정 |
| `backend/api/member.js` | 1014 | 원본 텍스트/설정 |
| `backend/api/message.js` | 728 | 원본 텍스트/설정 |
| `backend/api/team.js` | 2086 | 원본 텍스트/설정 |
| `backend/app.js` | 4648 | 원본 텍스트/설정 |
| `backend/auth.js` | 699 | 원본 텍스트/설정 |
| `backend/build/config.gypi` | 2549 | 원본 텍스트/설정 |
| `backend/db-dev.sqlite` | 28672 | SQLite |
| `backend/index.js` | 652 | 원본 텍스트/설정 |
| `backend/models.js` | 3026 | 원본 텍스트/설정 |
| `backend/package-lock.json` | 122297 | 원본 텍스트/설정 |
| `backend/package.json` | 703 | 원본 텍스트/설정 |
| `backend/public/index.html` | 2662 | 원본 텍스트/설정 |
| `backend/upload/boardfiles/1/1574001391408_room1.jpg` | 209630 | 이미지 |
| `backend/upload/boardfiles/2/1574053502797_Card.vue` | 2610 | 원본 텍스트/설정 |
| `frontend/README.md` | 339 | 원본 텍스트/설정 |
| `frontend/arrow_next.svg` | 355 | 원본 텍스트/설정 |
| `frontend/arrow_prev.svg` | 372 | 원본 텍스트/설정 |
| `frontend/dist/build.js` | 196553 | 생성 번들 |
| `frontend/dist/build.js.map` | 1507813 | 생성 번들 |
| `frontend/index.html` | 247 | 원본 텍스트/설정 |
| `frontend/package-lock.json` | 337572 | 원본 텍스트/설정 |
| `frontend/package.json` | 1616 | 원본 텍스트/설정 |
| `frontend/src/App.vue` | 1919 | 원본 텍스트/설정 |
| `frontend/src/api/index.js` | 3822 | 원본 텍스트/설정 |
| `frontend/src/assets/data/list.json` | 763 | 원본 텍스트/설정 |
| `frontend/src/assets/images/a.png` | 59986 | 이미지 |
| `frontend/src/assets/images/chat-icon.svg` | 1168 | 원본 텍스트/설정 |
| `frontend/src/assets/images/close-icon-big.png` | 340 | 이미지 |
| `frontend/src/assets/images/close-icon.png` | 571 | 이미지 |
| `frontend/src/assets/images/close.svg` | 969 | 원본 텍스트/설정 |
| `frontend/src/assets/images/favicon.png` | 1166 | 이미지 |
| `frontend/src/assets/images/file.svg` | 3156 | 원본 텍스트/설정 |
| `frontend/src/assets/images/git.png` | 993 | 이미지 |
| `frontend/src/assets/images/glass.png` | 578 | 이미지 |
| `frontend/src/assets/images/glass_black.png` | 1250 | 이미지 |
| `frontend/src/assets/images/home_logo.png` | 1997 | 이미지 |
| `frontend/src/assets/images/home_logoaa.png` | 16497 | 이미지 |
| `frontend/src/assets/images/left_btn.png` | 326 | 이미지 |
| `frontend/src/assets/images/logo-no-bg.svg` | 1281 | 원본 텍스트/설정 |
| `frontend/src/assets/images/logo.png` | 16958 | 이미지 |
| `frontend/src/assets/images/menu_logo.png` | 7103 | 이미지 |
| `frontend/src/assets/images/pngfind.com-github-logo-png-1766942.png` | 12862 | 이미지 |
| `frontend/src/assets/images/user_icon.png` | 3127 | 이미지 |
| `frontend/src/assets/images/ws.png` | 5376 | 이미지 |
| `frontend/src/assets/logo.png` | 6849 | 이미지 |
| `frontend/src/components/AddBoard.vue` | 2867 | 원본 텍스트/설정 |
| `frontend/src/components/AddCard.vue` | 1852 | 원본 텍스트/설정 |
| `frontend/src/components/AddList.vue` | 1421 | 원본 텍스트/설정 |
| `frontend/src/components/AddTeam.vue` | 1398 | 원본 텍스트/설정 |
| `frontend/src/components/Board.vue` | 8658 | 원본 텍스트/설정 |
| `frontend/src/components/BoardSettings.vue` | 5871 | 원본 텍스트/설정 |
| `frontend/src/components/Calendar.vue` | 6298 | 원본 텍스트/설정 |
| `frontend/src/components/CalendarModal.vue` | 2033 | 원본 텍스트/설정 |
| `frontend/src/components/CalendarModal_bk.vue` | 1899 | 원본 텍스트/설정 |
| `frontend/src/components/Calendar_bk.vue` | 6296 | 원본 텍스트/설정 |
| `frontend/src/components/Card.vue` | 8451 | 원본 텍스트/설정 |
| `frontend/src/components/CardItem.vue` | 4204 | 원본 텍스트/설정 |
| `frontend/src/components/CardModal.vue` | 2503 | 원본 텍스트/설정 |
| `frontend/src/components/Card_bk.vue` | 4727 | 원본 텍스트/설정 |
| `frontend/src/components/ChangePW.vue` | 2049 | 원본 텍스트/설정 |
| `frontend/src/components/Chat.vue` | 25870 | 원본 텍스트/설정 |
| `frontend/src/components/Code.vue` | 4871 | 원본 텍스트/설정 |
| `frontend/src/components/CodeModal.vue` | 1903 | 원본 텍스트/설정 |
| `frontend/src/components/Code_bk.vue` | 1330 | 원본 텍스트/설정 |
| `frontend/src/components/Home.vue` | 2953 | 원본 텍스트/설정 |
| `frontend/src/components/Left.vue` | 2898 | 원본 텍스트/설정 |
| `frontend/src/components/List.vue` | 3638 | 원본 텍스트/설정 |
| `frontend/src/components/Login.vue` | 1661 | 원본 텍스트/설정 |
| `frontend/src/components/Modal.vue` | 1969 | 원본 텍스트/설정 |
| `frontend/src/components/MyPage.vue` | 8242 | 원본 텍스트/설정 |
| `frontend/src/components/Navbar.vue` | 4178 | 원본 텍스트/설정 |
| `frontend/src/components/NotFound.vue` | 123 | 원본 텍스트/설정 |
| `frontend/src/components/Profile.vue` | 6384 | 원본 텍스트/설정 |
| `frontend/src/components/Search.vue` | 3368 | 원본 텍스트/설정 |
| `frontend/src/components/SearchBox.vue` | 1209 | 원본 텍스트/설정 |
| `frontend/src/components/SignUp.vue` | 2158 | 원본 텍스트/설정 |
| `frontend/src/components/Team.vue` | 10138 | 원본 텍스트/설정 |
| `frontend/src/components/TeamBox.vue` | 1464 | 원본 텍스트/설정 |
| `frontend/src/components/UserInfo.vue` | 2184 | 원본 텍스트/설정 |
| `frontend/src/components/YUnotice.vue` | 2436 | 원본 텍스트/설정 |
| `frontend/src/css/main.css` | 3520 | 원본 텍스트/설정 |
| `frontend/src/main.js` | 770 | 원본 텍스트/설정 |
| `frontend/src/router/index.js` | 1818 | 원본 텍스트/설정 |
| `frontend/src/store/actions.js` | 5866 | 원본 텍스트/설정 |
| `frontend/src/store/getters.js` | 98 | 원본 텍스트/설정 |
| `frontend/src/store/index.js` | 368 | 원본 텍스트/설정 |
| `frontend/src/store/mutations.js` | 1937 | 원본 텍스트/설정 |
| `frontend/src/store/state.js` | 445 | 원본 텍스트/설정 |
| `frontend/src/utils/dragger.js` | 823 | 원본 텍스트/설정 |
| `frontend/user_icon.png` | 3127 | 이미지 |
| `frontend/webpack.config.js` | 1882 | 원본 텍스트/설정 |
