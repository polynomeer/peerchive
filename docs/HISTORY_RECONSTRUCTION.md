# 이력 재구성 기록

2026-10-13에 사용자의 요청으로 수행했습니다. 아래 2019년 날짜는 Asia/Seoul(+09:00) 기준으로 author date와 committer date 모두 배정했습니다.
실제 당시 개발일·순서·중간 구현을 입증하지 않습니다. 커밋마다 retrospective reconstruction임을 명시했습니다.
각 단계는 최종 원본 파일을 추가하는 보존 단위이며 독립 실행 가능한 개발 단계가 아닙니다.

## 원본과 보존 범위

- 기존 HEAD: `97b5a9c363dee2a6441231c83bcb88e9a4319d05`
- 개발 원본: `92f14ceee51236286300e1cfc10e3b98dc8d201d` (2020-05-02의 마지막 일괄 업로드 정리)
- 백업 브랜치: [`backup/pre-reconstruction-20261013`](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013). 로컬과 원격 모두 기존 HEAD를 보존합니다.
- 추가 백업: `/private/tmp/proofu-before-reconstruction-20261013.bundle` (임시 경로이므로 장기 보존 시 별도 복사)
- 재구성 개발 기록 브랜치: `codex/reconstructed-2019` (로컬)
- 2026-10-13에 로컬 및 [원격 master](https://github.com/polynomeer/proofu-univ/tree/master)에 재구성 기록을 반영했습니다. 원격 백업 브랜치를 먼저 게시한 뒤, 기존 원격 HEAD를 지정한 `--force-with-lease`로 master를 갱신했습니다.
- 원격 반영 직후 master는 `90a597d015d848e2b178345f591bdd8af8c20706`, 백업은 `97b5a9c363dee2a6441231c83bcb88e9a4319d05`임을 확인했습니다. 이후 문서 업데이트 커밋은 master 뒤에 추가합니다.
- 이후 기존 커밋 103개(merge 55개 포함)를 원래 부모 연결 구조와 순서로 연결했습니다. 모든 tree, 작성자, 작성/커밋 날짜, 메시지를 보존했습니다. 부모 해시 변경으로 커밋 해시는 변경되었습니다.
- 원본 일괄 업로드 커밋 11개는 재구성 개발 기록의 마지막 커밋으로 매핑했습니다. 기존 개발 코드, lockfile, 바이너리, 배포 산출물 내용은 동일합니다.
- Codex 환경·분석 문서는 merge 이력 뒤에 현재 날짜의 별도 커밋으로 추가했습니다.

## 작업 단위

| 날짜 | 커밋 | 작업 | 파일 수 |
|---|---|---|---|
| 2019-06-03 | `54a6bf6` | chore: archive project manifests and build configuration | 8 |
| 2019-06-14 | `c299ec2` | feat: archive relational collaboration models | 1 |
| 2019-06-27 | `86c1c1b` | feat: archive JWT authentication service | 2 |
| 2019-07-05 | `bd29039` | feat: archive application shell and visual assets | 27 |
| 2019-07-16 | `da27b35` | feat: archive client API and Vuex state management | 6 |
| 2019-07-26 | `7136e35` | feat: archive authentication and profile screens | 5 |
| 2019-08-06 | `4f92fb4` | feat: archive team membership and join APIs | 3 |
| 2019-08-16 | `1b26cf5` | feat: archive team workspace screens | 3 |
| 2019-08-27 | `1c9e37a` | feat: archive board list and card APIs | 3 |
| 2019-09-06 | `50ffa55` | feat: archive Kanban board and list interactions | 6 |
| 2019-09-17 | `e038b2a` | feat: archive card editing and shared modals | 5 |
| 2019-09-27 | `dc08c03` | feat: archive navigation search and project dashboard | 8 |
| 2019-10-08 | `454ae9c` | feat: archive team chat and message persistence | 2 |
| 2019-10-18 | `be71b15` | feat: archive file uploads and code attachment screens | 4 |
| 2019-10-29 | `13b55e2` | feat: archive university notice integration | 2 |
| 2019-11-08 | `7dc8ccc` | feat: archive calendar interface and local state | 2 |
| 2019-11-18 | `c42017f` | chore: archive server wiring and demonstration data | 7 |
| 2019-11-29 | `6a9a2f5` | chore: archive distribution bundles and prototype variants | 6 |

파일별 배정 및 기존/신규 커밋 전체 대응은 `history-map.json`에 기록했습니다.

## 검증과 복구

`python3 scripts/check_archive.py`는 원본 파일 blob, 개발 스냅샷 tree, 날짜 범위, 커밋 대응과 모든 부모 연결 및 메타데이터를 검증합니다.
앱의 실행 성공을 의미하지 않습니다.

원본 조회는 `git log backup/pre-reconstruction-20261013`로 가능합니다.
원본으로 돌아가려면 작업 변경을 보관한 뒤 `git switch backup/pre-reconstruction-20261013`를 사용하세요.
기존 이력은 [원격 백업 브랜치](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013)에서도 조회할 수 있습니다. 재구성 이력의 원격 반영은 완료되었으며, 백업 브랜치는 유지합니다.
