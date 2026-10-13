# ProofU

[한국어](README.md) | **English**

ProofU is a **team project collaboration service** developed as an undergraduate graduation project. It brings team formation and membership requests, Kanban task management, file sharing, and team chat into one application. The code also includes project search, personal activity views, university notices, and a calendar interface.

This repository preserves the project's source code, sample data, and distribution artifacts. Missing files and legacy dependencies currently prevent it from being ready to run immediately after installation.

## Main features

These features are represented in the archived code; this list does not indicate that they have passed current runtime verification.

| Feature | Description |
|---|---|
| Accounts and profiles | JWT login and screens for registration, profiles, and password changes. The user API implementation file is currently missing. |
| Team management | Create, view, and edit teams; request and approve membership; manage member roles and areas of interest. |
| Kanban task management | Project boards with Todo/Doing/Done lists, card creation/editing/deletion, and drag-and-drop ordering of lists and cards. |
| File sharing | Board and card attachments, with FilePond upload and preview interfaces. |
| Team chat | Team-specific chat rooms, message persistence and retrieval through REST APIs, and Socket.IO change notifications. |
| Search and activity views | Search project titles and descriptions, browse by view count, and view personal activity timelines and language/field charts. |
| University notices | Integration code that collects and displays notices from Yeungnam University's website. |
| Calendar interface | A DaySpan/Vuetify calendar with browser storage code. Duplicate component options overwrite calendar logic, and there is no server-side calendar API. |

## Technology stack

This table describes the archived source and current dependency declarations. Later dependency updates are included, so these are not necessarily the versions used in 2019.

| Area | Technologies |
|---|---|
| Frontend | Vue 2, Vue Router 3, Vuex 3, Axios |
| UI and interactions | Dragula, FilePond/vue-filepond, Chart.js/vue-chartkick, DaySpan/Vuetify integration code |
| Build tooling | Webpack 3, Babel 6, webpack-dev-server |
| Backend | Node.js, Express 4, Sequelize 6, MySQL |
| Authentication and communication | JSON Web Token, Socket.IO 2 |
| Notice collection | Axios, Cheerio |

A development SQLite database is also preserved, but the active server configuration uses MySQL. Some packages used by the source, including Vuetify, DaySpan, and an icon package, are missing from direct dependency declarations.

## Project structure

```text
.
├── frontend/
│   ├── src/
│   │   ├── components/     # Vue screens for teams, boards, cards, chat, calendar
│   │   ├── api/            # Axios REST API calls
│   │   ├── router/         # Routing and authentication guards
│   │   ├── store/          # Vuex state, actions, and mutations
│   │   ├── assets/         # Images and sample data
│   │   ├── css/            # Shared styles
│   │   └── utils/          # Helpers such as drag ordering calculations
│   ├── dist/               # Archived distribution bundle and source map
│   └── webpack.config.js
├── backend/
│   ├── api/                # Auth, team, Kanban, message, attachment, notice APIs
│   ├── app.js              # Express routes and Socket.IO wiring
│   ├── index.js            # Database synchronization and HTTP server startup
│   ├── models.js           # Sequelize models and relationships
│   ├── auth.js             # JWT issuance and verification
│   ├── public/             # Static HTML
│   ├── upload/             # Sample uploads
│   └── db-dev.sqlite       # Archived development database
├── docs/                   # Project analysis and history reconstruction records
├── scripts/check_archive.py
└── AGENTS.md               # Codex working instructions
```

The typical data flow is Vue screens → Vuex → Axios → Express APIs → Sequelize/MySQL. Chat messages are persisted through REST APIs, while Socket.IO delivers team-specific change notifications. The default HTTP API port is `3000`, and the Socket.IO port is `10000`.

## Current runtime limitations

- **Missing user API:** `backend/app.js` imports `backend/api/user.js`, which is absent and blocks server startup.
- **Dependency and runtime compatibility:** The project includes legacy Vue/Webpack/Babel versions, native sqlite3 modules, and Puppeteer installation behavior. Installation, build, and runtime compatibility with the current Node.js environment has not been verified. Frontend dependency declarations also need attention.
- **Existing implementation issues:** Duplicate calendar `data`, `mounted`, and `methods` options, upload paths that can send two responses, and older API usage remaining after Sequelize updates require review.
- **Configuration and authentication:** MySQL connection settings and the JWT key are hardcoded. Plaintext password comparison and logging remain, as do missing ownership checks in some mutation APIs.
- **External integration and verification:** University notice collection depends on an older URL and HTML structure. Compatibility with the current website has not been checked, and the application has no automated test suite or CI configuration.

The existing entry points are listed below. Missing files and compatibility issues must be resolved, and MySQL must be prepared, before using them.

| Directory | Command | Purpose |
|---|---|---|
| `frontend/` | `npm run dev` | Frontend development server |
| `frontend/` | `npm run build` | Generate distribution artifacts |
| `backend/` | `node index.js` | Synchronize the database and start the server |

The history reconstruction preserved the original source unchanged. The subsequent comment and example cleanup described below kept executable code and dependencies unchanged. Dependencies were not installed, and application runtime restoration was not performed. See the [project analysis](docs/PROJECT_ANALYSIS.en.md) for detailed findings and suggested runtime restoration steps.

## Development history and backup

**The 18 commits dated June–November 2019 are a retrospective, feature-based reconstruction of the original code uploaded in 2020.** Dates and task ordering were assigned for archival purposes; they are not recovered development logs or evidence of the actual development dates. Each commit adds a group of archived files and does not represent an independently runnable intermediate version.

The reconstructed milestones are followed by 103 existing subsequent commits, including 55 merge commits. Existing file contents, commit messages, authors, dates, and merge topology were preserved. Commit hashes changed because parent references changed.

The reconstructed history was published to [remote master](https://github.com/polynomeer/proofu-univ/tree/master) on October 13, 2026. The original history remains available locally and on the [remote backup branch `backup/pre-reconstruction-20261013`](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013).

Per-commit file assignments and instructions for accessing the original history are recorded in the [history reconstruction document](docs/HISTORY_RECONSTRUCTION.en.md) and the [commit mapping](docs/history-map.json).

## Comment and example cleanup

On October 13, 2026, unused external example links, commented imports, and demo user/board setup were removed, and generic frontend instructions were replaced with links to the project documentation. Seven files were cleaned up. Executable code, active UI markup, dependencies, and required copyright and license notices were retained.

The cleanup was appended as a subsequent commit. The reconstructed 2019 history, existing history, and backups remain intact. Original and cleaned blob hashes for each changed file are recorded in the [cleanup mapping](docs/archive-cleanup.json).

## Archive verification and further reading

From the repository root, verify preservation of the original files and reconstructed history without installing application dependencies:

```sh
python3 scripts/check_archive.py
```

The check distinguishes the preserved original archive from current working-tree files.

- It verifies the archived tree, backup branch, assigned 2019 commit dates and file groups, and parent connections and metadata of the existing subsequent commits.
- For the seven cleaned files, current contents are compared with the cleaned blob hashes in `docs/archive-cleanup.json`. Other original files are compared with their original blob hashes. Unexpected changes or missing files fail verification.
- The root `README.md` is excluded from original-file hash comparison because it is maintained documentation. The newly added English README and documents are also outside the original-file comparison scope.

This verifies archive/history integrity and agreement with the recorded cleanup. It does not establish that the application builds or runs successfully.

Further reading:

- [Project analysis](docs/PROJECT_ANALYSIS.en.md)
- [History reconstruction and recovery guide](docs/HISTORY_RECONSTRUCTION.en.md)
- [Codex working instructions (in Korean)](AGENTS.md)
