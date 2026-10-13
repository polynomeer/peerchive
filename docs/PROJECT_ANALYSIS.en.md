# ProofU project analysis

[한국어](PROJECT_ANALYSIS.md) | **English**

## Architecture and data flow

The application follows Vue 2 → Vue Router authentication guards → Vuex actions → Axios REST API calls → Express → Sequelize/MySQL.
Login tokens are stored in localStorage and attached to Axios Authorization headers. Socket.IO joins team-specific rooms and sends change notifications; message contents are persisted and retrieved through REST APIs.
The default HTTP API port is `3000`, and the Socket.IO port is `10000`. The frontend development server uses the Webpack configuration.

## Feature analysis

| Area | Files and behavior |
|---|---|
| Server startup | `backend/index.js` starts the HTTP server after database synchronization. `app.js` wires middleware, routes, and the Socket.IO server. |
| Data models | `models.js` defines User, Team, Member, Join, Board, List, Card, Message, BoardFile, and CardFile, with relationships for team members, membership requests, boards, lists, cards, and attachments. |
| Authentication and accounts | JWT handling in `auth.js` and login in `api/auth.js`; Login/SignUp/Profile/ChangePW/UserInfo screens. The implementation file for user CRUD routes is missing. |
| Teams | Team lookup/creation/editing, member roles and fields, and membership requests/approvals in `api/team.js`, `api/member.js`, and `api/join.js`; Team/TeamBox/AddTeam screens. |
| Kanban | Creation, editing, and deletion through board/list/card APIs. Default Todo/Doing/Done lists are sorted by `pos`. Board/List/Card, Add* components, and `dragger.js` update drag ordering. |
| Search and dashboard | LIKE searches on titles/descriptions and sorting by view count; Home/Search/SearchBox, plus MyPage activity timelines and language/field charts. |
| Files | Board/card attachment APIs and FilePond uploads. Code handles board attachments; Card/CardItem handle card attachments. Sample uploads are preserved. |
| Chat | `Chat.vue`, the message API, and Vuex socket state; team-specific join/leave/chat notifications and REST message lists. |
| Calendar | Calendar/CalendarModal and DaySpan/Vuetify. Code uses localStorage key `dayspanState`, but duplicate options overwrite the earlier implementation. No server-side calendar model or API exists. |
| University notices | The html API retrieves Yeungnam University HTML with Axios/Cheerio. YUnotice displays notices and team lists. |
| Shared UI | App/Navbar/Left/NotFound, shared Modal and Card/Code/Calendar modals, `main.css`, images, and SVG assets. |
| State and routing | Vuex state/getters/mutations/actions, the API facade, token restoration, protected screens, and nested card routes under boards. |
| Distribution and samples | Original frontend/dist bundles and source maps, backend/public HTML, SQLite database, sample uploads, node-gyp configuration, and `*_bk.vue` variants are preserved. |

## Runtime and maintenance limitations

- `backend/api/user.js`, required by `backend/app.js`, is absent. Installing dependencies alone cannot make the server run.
- Vuetify and icon CSS in `frontend/src/main.js`, and dayspan in `Calendar.vue`, lack direct dependency declarations. These declarations need review regardless of whether packages are available transitively.
- Duplicate `data`, `mounted`, and `methods` options in `Calendar.vue` cause later definitions to overwrite earlier calendar logic. The `description` binding also needs review.
- MySQL connection settings and the JWT key are hardcoded. Login compares and logs plaintext passwords. Several update/delete routes lack ownership checks.
- File upload paths can respond both in the upload callback and at the end of the handler, causing duplicate responses. File deletion APIs remove database records only.
- Sequelize was updated to 6.x after the original upload, while older API usage remains, such as the Promise `.map` pattern in list deletion.
- Legacy Vue/Webpack/Babel versions, native sqlite3 modules, and Puppeteer installation behavior are included. Compatibility with the Node 23 environment used during the archive work was not verified.
- The archive lacks application automated tests, CI, and a Babel configuration file. The documentation/history work did not install dependencies, call the university website, change the database, or modify application behavior.

A separate runtime restoration effort should start with recovering the missing user API, checking runtime/dependency compatibility, externalizing configuration, and then verifying REST, chat, attachment, and calendar behavior.

## History reconstruction and backup

The 18 commits dated June–November 2019 are a retrospective, feature-based reconstruction of code uploaded in 2020. Their dates and ordering were assigned for archival purposes, not recovered from actual development logs. Intermediate archive milestones are not independently runnable versions.

The reconstructed history was published to [remote master](https://github.com/polynomeer/peerchive/tree/master) on October 13, 2026. The original history remains on the local and [remote backup branch `backup/pre-reconstruction-20261013`](https://github.com/polynomeer/peerchive/tree/backup/pre-reconstruction-20261013). See the [history reconstruction and recovery guide](HISTORY_RECONSTRUCTION.en.md) for commit assignments, preservation details, and recovery instructions.

## Complete original file inventory

The table lists all tracked files at the original HEAD `97b5a9c363dee2a6441231c83bcb88e9a4319d05`, before history reconstruction and documentation updates. Text source was reviewed for features, imports, and state flow; lockfiles for JSON structure and versions; binaries for format and size; and distribution artifacts for preservation. Third-party code inside bundles was not individually audited. Sizes describe the original snapshot, not the current documentation files.

| File | Bytes | Type |
|---|---:|---|
| `README.md` | 8 | Original text/configuration |
| `backend/api/auth.js` | 529 | Original text/configuration |
| `backend/api/board.js` | 3790 | Original text/configuration |
| `backend/api/boardfile.js` | 796 | Original text/configuration |
| `backend/api/card.js` | 1418 | Original text/configuration |
| `backend/api/cardfile.js` | 786 | Original text/configuration |
| `backend/api/html.js` | 798 | Original text/configuration |
| `backend/api/join.js` | 684 | Original text/configuration |
| `backend/api/list.js` | 1696 | Original text/configuration |
| `backend/api/member.js` | 1014 | Original text/configuration |
| `backend/api/message.js` | 728 | Original text/configuration |
| `backend/api/team.js` | 2086 | Original text/configuration |
| `backend/app.js` | 4648 | Original text/configuration |
| `backend/auth.js` | 699 | Original text/configuration |
| `backend/build/config.gypi` | 2549 | Original text/configuration |
| `backend/db-dev.sqlite` | 28672 | SQLite |
| `backend/index.js` | 652 | Original text/configuration |
| `backend/models.js` | 3026 | Original text/configuration |
| `backend/package-lock.json` | 122297 | Original text/configuration |
| `backend/package.json` | 703 | Original text/configuration |
| `backend/public/index.html` | 2662 | Original text/configuration |
| `backend/upload/boardfiles/1/1574001391408_room1.jpg` | 209630 | Image |
| `backend/upload/boardfiles/2/1574053502797_Card.vue` | 2610 | Original text/configuration |
| `frontend/README.md` | 339 | Original text/configuration |
| `frontend/arrow_next.svg` | 355 | Original text/configuration |
| `frontend/arrow_prev.svg` | 372 | Original text/configuration |
| `frontend/dist/build.js` | 196553 | Generated bundle |
| `frontend/dist/build.js.map` | 1507813 | Generated bundle |
| `frontend/index.html` | 247 | Original text/configuration |
| `frontend/package-lock.json` | 337572 | Original text/configuration |
| `frontend/package.json` | 1616 | Original text/configuration |
| `frontend/src/App.vue` | 1919 | Original text/configuration |
| `frontend/src/api/index.js` | 3822 | Original text/configuration |
| `frontend/src/assets/data/list.json` | 763 | Original text/configuration |
| `frontend/src/assets/images/a.png` | 59986 | Image |
| `frontend/src/assets/images/chat-icon.svg` | 1168 | Original text/configuration |
| `frontend/src/assets/images/close-icon-big.png` | 340 | Image |
| `frontend/src/assets/images/close-icon.png` | 571 | Image |
| `frontend/src/assets/images/close.svg` | 969 | Original text/configuration |
| `frontend/src/assets/images/favicon.png` | 1166 | Image |
| `frontend/src/assets/images/file.svg` | 3156 | Original text/configuration |
| `frontend/src/assets/images/git.png` | 993 | Image |
| `frontend/src/assets/images/glass.png` | 578 | Image |
| `frontend/src/assets/images/glass_black.png` | 1250 | Image |
| `frontend/src/assets/images/home_logo.png` | 1997 | Image |
| `frontend/src/assets/images/home_logoaa.png` | 16497 | Image |
| `frontend/src/assets/images/left_btn.png` | 326 | Image |
| `frontend/src/assets/images/logo-no-bg.svg` | 1281 | Original text/configuration |
| `frontend/src/assets/images/logo.png` | 16958 | Image |
| `frontend/src/assets/images/menu_logo.png` | 7103 | Image |
| `frontend/src/assets/images/pngfind.com-github-logo-png-1766942.png` | 12862 | Image |
| `frontend/src/assets/images/user_icon.png` | 3127 | Image |
| `frontend/src/assets/images/ws.png` | 5376 | Image |
| `frontend/src/assets/logo.png` | 6849 | Image |
| `frontend/src/components/AddBoard.vue` | 2867 | Original text/configuration |
| `frontend/src/components/AddCard.vue` | 1852 | Original text/configuration |
| `frontend/src/components/AddList.vue` | 1421 | Original text/configuration |
| `frontend/src/components/AddTeam.vue` | 1398 | Original text/configuration |
| `frontend/src/components/Board.vue` | 8658 | Original text/configuration |
| `frontend/src/components/BoardSettings.vue` | 5871 | Original text/configuration |
| `frontend/src/components/Calendar.vue` | 6298 | Original text/configuration |
| `frontend/src/components/CalendarModal.vue` | 2033 | Original text/configuration |
| `frontend/src/components/CalendarModal_bk.vue` | 1899 | Original text/configuration |
| `frontend/src/components/Calendar_bk.vue` | 6296 | Original text/configuration |
| `frontend/src/components/Card.vue` | 8451 | Original text/configuration |
| `frontend/src/components/CardItem.vue` | 4204 | Original text/configuration |
| `frontend/src/components/CardModal.vue` | 2503 | Original text/configuration |
| `frontend/src/components/Card_bk.vue` | 4727 | Original text/configuration |
| `frontend/src/components/ChangePW.vue` | 2049 | Original text/configuration |
| `frontend/src/components/Chat.vue` | 25870 | Original text/configuration |
| `frontend/src/components/Code.vue` | 4871 | Original text/configuration |
| `frontend/src/components/CodeModal.vue` | 1903 | Original text/configuration |
| `frontend/src/components/Code_bk.vue` | 1330 | Original text/configuration |
| `frontend/src/components/Home.vue` | 2953 | Original text/configuration |
| `frontend/src/components/Left.vue` | 2898 | Original text/configuration |
| `frontend/src/components/List.vue` | 3638 | Original text/configuration |
| `frontend/src/components/Login.vue` | 1661 | Original text/configuration |
| `frontend/src/components/Modal.vue` | 1969 | Original text/configuration |
| `frontend/src/components/MyPage.vue` | 8242 | Original text/configuration |
| `frontend/src/components/Navbar.vue` | 4178 | Original text/configuration |
| `frontend/src/components/NotFound.vue` | 123 | Original text/configuration |
| `frontend/src/components/Profile.vue` | 6384 | Original text/configuration |
| `frontend/src/components/Search.vue` | 3368 | Original text/configuration |
| `frontend/src/components/SearchBox.vue` | 1209 | Original text/configuration |
| `frontend/src/components/SignUp.vue` | 2158 | Original text/configuration |
| `frontend/src/components/Team.vue` | 10138 | Original text/configuration |
| `frontend/src/components/TeamBox.vue` | 1464 | Original text/configuration |
| `frontend/src/components/UserInfo.vue` | 2184 | Original text/configuration |
| `frontend/src/components/YUnotice.vue` | 2436 | Original text/configuration |
| `frontend/src/css/main.css` | 3520 | Original text/configuration |
| `frontend/src/main.js` | 770 | Original text/configuration |
| `frontend/src/router/index.js` | 1818 | Original text/configuration |
| `frontend/src/store/actions.js` | 5866 | Original text/configuration |
| `frontend/src/store/getters.js` | 98 | Original text/configuration |
| `frontend/src/store/index.js` | 368 | Original text/configuration |
| `frontend/src/store/mutations.js` | 1937 | Original text/configuration |
| `frontend/src/store/state.js` | 445 | Original text/configuration |
| `frontend/src/utils/dragger.js` | 823 | Original text/configuration |
| `frontend/user_icon.png` | 3127 | Image |
| `frontend/webpack.config.js` | 1882 | Original text/configuration |
