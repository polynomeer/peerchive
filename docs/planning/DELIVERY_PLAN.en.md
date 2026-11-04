# Peerchive delivery plan and validation criteria

[한국어](DELIVERY_PLAN.md) | **English**

Written: 2026-10-18 · Updated: 2026-10-24 (campus community in §4.1, §5.1, §6.1, §9.1, and gate GC; public profiles, following, alumni, topics, and organizations in §4.2, §4.3, §5.2, §5.3, §6.2, §9.2, and gates GP and GA) · Status: consolidated proposal

[Product proposal](../PROOFU_EVOLUTION_PLAN.en.md) · [System design](SYSTEM_DESIGN.en.md)

Peerchive is the new name of the project that continues from **ProofU**, an undergraduate graduation project built in 2019. The schedules, metrics, and criteria below are proposals to be validated, not a committed plan or the results of research already carried out.

## 1. Assumptions

- We assume one developer contributing 20–30 hours per week, one user-research/operations collaborator contributing 3–5 hours per week, and access to a first student cohort (one school, two or three courses).
- If actual effort is 10 hours per week, roughly 2.5–3 times more calendar time is needed. In that case, apply the reduced scope in [product proposal §16](../PROOFU_EVOLUTION_PLAN.en.md#16-mvp-scope).
- The schedule follows the Korean academic calendar: terms start in March and September and end in June and December, and companies run open recruitment seasons in the first and second halves of the year. We expect discovery demand to peak in the first two weeks of a term, case publication right after the term ends, and portfolio sharing during recruitment season.
- Do not spend time first on making the legacy original runnable. While confirming value through manual experiments, build the smallest vertical flow of the new app.
- Even when budget or time runs short, do not skip authorization checks, file quarantine, publication withdrawal, or recovery; reduce feature scope instead. Policies, operations, accessibility, and institutional review at commercial-launch level are separate scope after the pilot.

## 2. Validation experiments before development

Run these with Notion, Discord, static pages, and spreadsheets before writing code. Do not force students to hand over assignment files or make private materials public for research purposes.

### 2.1 Interviews

| Participants | Number | Key questions |
|---|---|---|
| Current students | 8–12 | In your last team assignment, how did you prove who did what? Have you ever received past materials passed down from seniors, and what was most useful? Where did you record judgments, failures, and validation along the way? What did you have to redo when building a portfolio? How much would you publish, and whose consent is needed? What does your team use for chat? Do you recruit study groups or ask assignment questions on Everytime or similar apps, and have you wished those conversations had been kept as records? |
| People with hiring-review experience | 4–6 | View three student cases for 90 seconds each and explain the role, evidence, and possible interview questions. Do not infer from interviews any commitment that companies will use the platform |
| Professors, teaching assistants, mentors | 2–3 | Actual publication conditions and concerns, acceptability of publishing after the term (embargo), potential use of contribution reports for peer evaluation |

### 2.2 Experiments

| ID | Experiment | Method | Draft condition for proceeding | If unmet |
|---|---|---|---|---|
| E0 | Manual operation | 2–3 teams run an assignment for four weeks with a Notion build log template + a Discord channel; weekly check-ins via form; contribution summaries written manually by the operator | At least half of teams record in three or more of four weeks; median time to write a record within five minutes | Reduce tags, shift to a file- and check-in-centered flow, raise bot priority |
| E1 | Replacing passed-down materials | Give 8 students about to take the course a manual course hub prototype (senior notes, stuck cards, final-artifact links); after they write a first-week plan, have them rank how useful the information was | At least 5 of 8 propose a concrete next action from the reference material; at least 6 say stuck cards and senior notes are more useful than final artifacts | Shrink the course hub; focus on records and portfolios |
| E2 | Retrospective writing | 5 graduates retrospectively write up one past assignment as milestones, stuck cards, and decisions | At least 4 finish within 30 minutes; at least 3 consent to publication | Split input units further into senior notes and stuck cards |
| E3 | Case organization | Organize 3–5 consenting completed assignments in a “Problem / My contribution / Key decisions / How it was verified / Result / Limitations / Sources” format and compare with plain artifact links | Shorter portfolio writing time; better reader understanding | Adjust the order and fields of the format |
| E4 | Hiring-reviewer comparison | Show 5 reviewers the same student's GitHub link vs. a case card + competency × evidence | At least 4 accurately explain the main role and evidence and write more specific interview questions | Improve summary order and individual/team separation |
| E5 | Embargo and publication acceptability | Explain publication levels and embargo rules to professors, TAs, and students | Most faculty say “acceptable if published after the term”; secure at least 5 cases with consent and conditions in place | Limit publication scope to concept/summary level; pilot with clubs and personal projects that permit publication |
| E6 | Graduate supply | Around the end of the 2026 fall term, ask graduates and senior-year students for senior notes and stuck cards | 10 senior notes and 20 stuck cards per course | Narrow target courses; operator interviews and ghostwrites (with author approval) |

The E0 recording experiment starts with half free-form records and half tagged build logs to find obstacles. Because the sample is small, the goal is discovering obstacles rather than statistical confirmation. Fix measurement methods before recruitment, and do not quietly change criteria to fit the results.

Even if results show students find it hard to publish actual submissions, that is no reason to abandon the project. Adjust supply scope to projects that may be published after submission, club work intended for publication, personal reimplementations of assignments, and senior notes.

## 3. Roadmap

| Stage | Period | Goals and implementation | Deliverables | Gate to next stage |
|---|---|---|---|---|
| **0. Validation** | 2026-10-19 ~ 11-29 (6 weeks) | Interviews, E0–E5, core-screen prototype, Nuxt/DB/file/bot technical experiments, preparation of ProofU first-case materials | Research summary, manual cases, hypothesis decisions, architecture decision records (ADRs) | **G0** |
| **0+. Supply campaign** | 2026-12 (around end of term) | E6: collect senior notes and stuck cards from graduates and senior-year students | Initial content for 2–3 courses | – |
| **1. MVP development** | 2026-12-01 ~ 2027-02-26 (13 weeks, winter break) | §4 backlog T-01–T-16 | private alpha → preparation for limited public | **G1** (week 7), **G2** preparation (week 13) |
| **2. Pilot** | 2027-03-02 ~ 06-30 (spring term) | Real use by 10–20 teams in one department, public course hubs, end-of-term publication campaign | Metrics, interviews, incident records | **G2** (before publishing public cases), **G3** |
| **3. Portfolio** | 2027-07 ~ 08 (summer break) | 1–3 P1 items that resolve the biggest obstacle found in experiments (candidates: AI case polishing, competency × evidence, restricted sharing/PDF, interview prep pack) | Portfolios for second-half recruitment season | Scope decided by G3 results |
| **4. Expansion** | 2027 fall term onward | Multiple departments and schools, Kanban board, GitHub App, stuck-card Q&A, semantic search, campus community (one pilot school, §4.1), public profiles and following (§4.2), alumni, topic, and organization expansion (P2, §4.3), class spaces, monetization experiments | – | **GC** (community launch), **GP** (public profiles and following), **GA** (alumni and organizations), **G4** |

Detailed implementation proceeds in **vertical feature slices** rather than completing each layer separately (e.g., finish the assignment creation screen, API, DB, and authorization tests together). Do not handle file scanning, the authorization model, or publication candidates as temporary patches right before the pilot.

### 3.1 Allocation of the 13-week MVP development

| Weeks | Work | Check on completion |
|---|---|---|
| 1–2 | T-01, T-02, T-03 | Tests blocking private reads between two users pass |
| 3–5 | T-04, T-05, T-06, T-07 | Logs and snapshots are created, edited, and preserved across reconnection; other teams' access is blocked |
| 6–7 | T-08, T-09 | Internal use with two teams; bot collection and contribution reports work → **G1** |
| 8–10 | T-10, T-11, T-12 | Regression tests for public leaks, embargo, and withdrawal pass |
| 11–12 | T-13, T-14, T-15 | One student goes from assignment → public case → course page → portfolio |
| 13 | T-16, buffer | Recovery drill, pilot instrumentation, G2 readiness check |

## 4. Implementation backlog and dependencies

| ID | Work | Dependencies | Completion criterion |
|---|---|---|---|
| P-01 | Interview and case template | None | Recording practices, publication obstacles, and hiring-review needs organized through actual cases |
| P-02 | Manual operation experiments (E0–E5) | P-01 | §2.2 decisions recorded |
| P-03 | Graduate supply campaign (E6) | P-01 | Initial content per course, author consent |
| T-01 | Development environment, DB migrations, CI | None | Pinned runtime, reproducible baseline deployment, archive checks run alongside |
| T-02 | Sessions and public/private profiles | T-01 | Tests for account state, session expiry, CSRF, public DTOs |
| T-03 | Assignments, invitations, project authorization | T-02 | Tests for invitation expiry, leaving, owner change, cross-team access |
| T-04 | Build logs, revisions, per-tag payloads | T-03 | Author permission, payload schema validation, 409 on stale versions, content preserved on save failure |
| T-05 | File upload, quarantine, scanning | T-03 | No viewing or publication before clean; limits, errors, duplicate requests handled |
| T-06 | Milestones, snapshots, evolution view | T-04, T-05 | Reordering; only clean versions can be designated as snapshots |
| T-07 | To-dos, completion toggling, retrospective mode | T-04 | Reordering without dragging; `retro_mode` marker preserved through public DTOs |
| T-08 | Role claims, teammate confirmation, contribution reports | T-04, T-05 | Confirmation invalidated when revision changes; self-confirmation and editing others' claims blocked; reports contain no private data from other teams |
| T-09 | Discord bot, weekly check-ins | T-04 | Account linking, idempotent collection, 📌 on someone else's message triggers an approval request, separate consent for statistics |
| T-10 | Schools, courses, concept tags, embargo | T-03 | Merge handling; server rejects publication requests before the term ends |
| T-11 | Publication candidates, review, preview, consent | T-06–T-10 | DTO built only from selected revisions; consent re-requested on manifest change; materials of non-consenting members excluded |
| T-12 | Publish, withdraw, block derivatives | T-11 | Transactional recheck; anonymous reads, files, and search blocked immediately after withdrawal |
| T-13 | Course hub, senior notes, plan fork, search | T-12 | Only public releases exposed; forks copy only plan elements |
| T-14 | Case template draft, portfolio, public profile | T-08, T-12 | Every sentence has a source; withdrawn cases automatically blocked; private fields absent from HTML, JSON, OG, and printed output |
| T-15 | Reports and moderation actions | T-12 | Search covers public state only; actions, appeals, and audit records |
| T-16 | Runbooks, recovery, pilot instrumentation | T-01–T-15 | DB + file recovery, deletion-ledger reapplication, analytics events without personal data |
| P-04 | Pilot evaluation and scope adjustment | P-02, T-16 | Decide next scope based on usage, publication, understanding, and operating cost |

The start order is T-01 → T-02/T-03 → T-04/T-05 → T-06/T-07 → T-08/T-09 → T-10 → T-11/T-12 → T-13/T-14/T-15 → T-16. These are task dependencies, not a committed plan for parallel staffing.

### 4.1 P1 campus community backlog

The community in [product plan §8.9](../PROOFU_EVOLUTION_PLAN.en.md#89-campus-community-rooms-and-pages-p1) opens at a single pilot school after the MVP has validated the archive flow (G3). The data model, permissions, and visibility follow [system design §6.7, §8.1, and §8.2](SYSTEM_DESIGN.en.md#67-campus-community-p1). Scope is the P1 row of product plan §16 (one official page, user rooms, recruiting and study rooms, per-thread anonymous numbers, reports and temporary hiding, moving questions into stuck logs); polls, "Most liked", more official department pages, and real-name warnings on anonymous posts are P2.

| ID | Task | Depends on | Done when |
|---|---|---|---|
| C-01 | School email verification, self-reported department | T-02, T-10 | Code expiry and retry limits, verification history kept for alumni, no student ID numbers, departments, or verification emails in public DTOs. The same record decides course hub writing eligibility |
| C-02 | Spaces, boards, memberships, join methods | C-01 | Only operators open official pages, opening requests counted (threshold 10, or student council), reserved names rejected, capacity 300, owner succession and archiving |
| C-03 | Name display mode and change history | C-02 | Mode frozen on posts and comments at write time; changes are scheduled 7 days ahead, notify members, and apply only to later posts; zero retroactive changes to earlier posts |
| C-04 | Posts, comments, likes, per-thread anonymous numbers | C-03 | Numbers persist within a thread and are unlinked across threads, `Author` label shown, no author identifiers in owner or moderator responses, no downvotes |
| C-05 | Visibility and search engine exclusion | C-02 | 404 for logged-out users, other schools, and non-members; `noindex`, robots, and sitemap exclusion; no Open Graph body previews; zero community bodies in public search, embeddings, or aggregates |
| C-06 | Reports, temporary hiding, restrictions, author identification | C-04, T-15 | Auto-hide when distinct verified reporters reach the threshold (5 official, 3 rooms); staged restrictions do not affect assignment spaces or portfolios; operator author identification requires a reason and audit entry |
| C-07 | Recruiting, applications, study room creation | C-04 | Same recruiting table as finding teammates, applicant list visible only to the recruiter and unranked, closing creates the study room and invitations |
| C-08 | Study records | C-07, T-06 | Build log and milestones usable in study rooms, publication through the publication process and member consent, records from anonymous study rooms cannot be linked to portfolios |
| C-09 | Moving into the archive | C-04, T-13 | Question and accepted answer → stuck log or Q&A; advice post → senior note. Nothing is copied before all parties consent, name display mode chosen again, original post keeps its visibility |
| C-10 | Moderation tools and instrumentation | C-06, T-16 | Report queue and handling time, weekly moderation hours recorded, §6.1 events (anonymous posts without user keys) |

The start order is C-01 → C-02 → C-03/C-05 → C-04 → C-06 → C-07/C-09 → C-08 → C-10. C-05 and C-06 are required by gate GC (§7), so they are finished before any feature expansion. Even when time is short, C-08 and C-09, which lead into the archive, are not deferred; instead, the official page is delayed and recruiting and study rooms (C-07) open first, because the goal is to confirm that the community leads into the archive.

### 4.2 P1 public profile and following backlog

The four identity levels in [product plan §4.4](../PROOFU_EVOLUTION_PLAN.en.md#44-identity-position-real-names-for-records-anonymity-for-lounges) and the per-item visibility, following, and social links in [§10.7](../PROOFU_EVOLUTION_PLAN.en.md#107-visibility-following-and-social-links-p1). The data model and permissions follow [system design §6.7.1, §8.3, §9.2, and §11.3](SYSTEM_DESIGN.en.md#671-identity-levels-public-profiles-and-following-p1). Scope is the P1 "Public profiles and following" row of product plan §16. Once public cases and portfolios (T-11–T-14) work in the pilot (G3), personas and visibility are built first in stage 4, and following and the feed open only after gate GP (§7).

| ID | Task | Depends on | Done when |
|---|---|---|---|
| S-01 | Personas, display names, real-name link flag | T-14 | One `real` and one `display` per account, unique handles, reserved words rejected. `Profile` and `PortfolioEdition` belong to personas. While the link is off, zero information about the other persona in either profile's HTML, JSON, OG, PDF, search, or follow lists; link toggles are audited |
| S-02 | Identity separation boundary | S-01, C-04 | Lint forbids the social module from importing community post tables, the social DB role has no SELECT on community posts, `PersonaActivity.persona_id NOT NULL`, no projection path for level 0–1 posts. Property-based regression test passes (zero level 0–1 posts in profiles, feed, follows, recommendations, search, OG, PDF). If the community is not open yet, test against the C-04 table schema alone |
| S-03 | Per-item visibility and assignment list | S-01, T-12 | Five audience levels and two for `follow_lists`. Public case items appear only through the publication process and cannot be widened by settings. `ProjectListing` shows course, semester, and title only, without the title during embargo. Access results for private assignment spaces are identical before and after any setting change |
| S-04 | Follow, private accounts, block, mute | S-03 | Approval flow for private accounts, no following of one's own personas, follower removal, block, and mute without notifications. Blocking returns 404 and deletes follows both ways; choosing `all_personas` shows the link-inference warning. Blocks do not apply to level 0–1 posts |
| S-05 | Profile posts, following feed, recommendations | S-02, S-04 | Permissions and source state rechecked at read time; withdrawal, hiding, blocks, and narrowed visibility apply from the next request. No popularity ranking or follower-count sorting; recommendations from overlapping courses, organizations, and target roles. The feed prioritizes records (cases, notes, studies) |
| S-06 | Social links and link-back check | S-01 | SSRF defenses in the link-fetching worker (allowed schemes, redirect limits, private IP blocking, timeouts), switch to `lost` on recheck, separate links per persona, usability check that `Verified` is not read as identity verification |
| S-07 | Reports and instrumentation | S-05, T-15 | Personas, profile posts, and social links added as report targets, display-name impersonation as a report reason, §6.2 events (level 0–1 posts without user keys) |

The start order is S-01 → S-02/S-03 → S-04 → S-06 → S-05 → S-07. **S-02 is finished before following and the feed.** If time is short, defer S-05's recommendations and S-06, and open public profiles with display names, visibility, and blocking (S-01–S-04) only.

### 4.3 P2 alumni, topic, and organization expansion backlog

The alumni and club OB rooms, cross-school topics with affiliation-labeled anonymity, and bootcamp and education provider expansion in [product plan §8.9.9–§8.9.11](../PROOFU_EVOLUTION_PLAN.en.md#899-alumni-spaces-alumni-and-club-ob-groups-and-commiseration-lounges-p2). The data model and permissions follow [system design §6.7.2, §8.4, and §9.2](SYSTEM_DESIGN.en.md#672-alumni-spaces-topics-and-organization-expansion-p2). Work starts after GC, once there is evidence that the community leads into the archive (§6.1) and gate GA (§7) has passed. Organization expansion (I-) follows a stable university pilot; if a university pilot is hard to reach and a bootcamp partnership is available first, the order is swapped per product plan §19.

| ID | Task | Depends on | Done when |
|---|---|---|---|
| A-01 | Alumni and OB room template, per-room profiles, status badges | C-02, S-01 | User rooms with `template = alumni`; zero per-room profiles outside the room, on public profiles, or in PersonaActivity; names fixed in real-name rooms; self-reported cohort with organizer edit history |
| A-02 | Events, RSVPs, notice read receipts, polls, albums | A-01, T-05 | One response per occurrence, notice reads return counts only, polls show totals only, albums with file scanning, EXIF removal, and short signed URLs; RSVPs and read records deleted on leaving |
| A-03 | Member directory consent | A-01 | Zero rows without consent, fields can be left empty, immediate deletion on withdrawal or leaving, no export path (API, CSV, PDF, bulk read), page-size and read rate limits |
| A-04 | Lounge media and alumni access | C-04, T-05 | Limits for images and short videos with metadata removal; alumni whose school email has expired can still read alumni boards and lounges through verification history |
| I-01 | Organization generalization and verification methods | C-01 | After adding `kind` and `method` to `institution`, zero regressions in existing university email verification. Hashed invite codes with expiry, use limits, and revocation; cohort approval by 2 members (approvers verified only by non-approval methods); certificate files deleted within 7 days of the decision and recorded in `DeletionLedger` |
| A-05 | Topics, affiliation-labeled anonymity, threshold | I-01, S-02, C-04 | Operator-only topic creation, `affiliation_label` frozen at write time, automatic broadening when `(organization, standing)` has fewer than 50 verified members, broadening disclosed only to the author, no departments, cohorts, or entry years, zero level 0–1 projections (S-02 tests extended) |
| A-06 | Moving practitioner answers, completion retrospectives | A-05, C-09 | Topic answer → senior note reuses `ArchiveTransfer` with name mode chosen again; completion retrospectives have no star rating, salary, or recommendation score fields |
| I-02 | Organization pages, cohort rooms, organization admins | I-01, A-01 | Organization admin rights never exceed owner and moderator rights, no author identification, no API to query users by organization, organization statistics only as thresholded aggregates |
| A-07 | Operations and instrumentation | A-02–A-06, C-10 | Report reasons for directories, events, and topics; processing queue per verification method (certificate review time recorded); P2 events in §6.2 |

The start order is A-01 → A-02/A-03 → A-04 → I-01 → A-05 → A-06 → I-02 → A-07. If alumni spaces strongly boost senior note supply (§6.2), A-01–A-03 can move up to P1 per product plan §19. When time is short, defer polls and albums (part of A-02) and lounge video (A-04) first; A-06, which leads into records, is not deferred.

### 4.4 P1 product-plan follow-up backlog

Items from the P1 rows of [product plan §16](../PROOFU_EVOLUTION_PLAN.md) (AI assistance, archive, portfolio and collaboration upgrades) and §8.5–§8.7, §10.5–§10.6 that had no ID in the backlogs above. A code audit on 2026-11-01 excluded what is already built: the competency × evidence matrix and README card (T-14) and the school-verified writing gate (C-01). On the roadmap (§3), E-08 and E-14 are stage 3 and E-04, E-05, E-09 and E-11 stage 4 candidates; they are implemented, but openings that need pilot evidence sit behind default-off flags.

| ID | Work | Depends on | Done when |
|---|---|---|---|
| E-01 | This term's course registration (§8.7) | T-10 | Students register by searching school and course (no crawling or account import); registrations are visible only to the student (0 in public profile and search); home shows hub, senior-note and plan-fork entry points per course; a project space created from a registered course gets course, term and embargo filled in; the hub's "N taking this term" appears only when n ≥ 5; after term end, senior-note and publication prompts |
| E-02 | Staged course hub opening (§8.6) | E-01, T-11 | Hub is closed while public cases + senior notes are below a threshold (setting, initially 3); registered students see "coming soon" and can ask to be notified; students who finished the course get a senior-note request; the hub opens on the next request once the threshold is reached |
| E-03 | Student curators (§8.6) | E-02, T-15 | Operators assign and remove 1–2 per course (audited); curators can only propose tag merges, write assignment-type summaries and do first-pass report review (no withdrawals, account actions or author lookup); activity can be shown as junior contribution in the portfolio by the curator's choice |
| E-04 | Stuck Q&A threads (§8.5) | T-11, C-04 | Questions only on published 🧱 logs whose author enabled them; per-thread `질문자`/`익명N` numbering with the log author always `작성자`; "helpful" affects card ordering only (no personal score); answerers choose whether anonymous answers count as junior contribution; reports and hiding; withdrawal of the publication closes the thread |
| E-05 | Semantic search for similar stuck items | T-12 | Only stuck/resolution text from public snapshots is embedded (0 from private spaces); withdrawn or hidden items drop out on the next request; keyword search still works without an embedding provider; embargoed courses excluded |
| E-06 | Interview prep pack (§10.5) | T-13 | Expected questions generated from decision and stuck citations of featured cases (templates, AI optional); answer notes are private; only questions the student selects appear to recruiters as "good questions to ask" |
| E-07 | Limited share links | T-14 | Per portfolio-edition token (hash stored), expiry, revocation, view count only; token pages are noindex and excluded from search; 404 from the next request after revocation; shows only the edition's public cases and never widens visibility |
| E-08 | Application PDF (§10.6) | T-14 | Server-generated PDF from the same public DTO as the print view, with evidence links; 0 information about an unlinked persona (S-01); generation rate limit |
| E-09 | Kanban board view (§6.6) | T-07 | Status-column board; keyboard and button alternatives with the same result as drag; same permissions and ordering data as the list view; completion-to-log prompt kept |
| E-10 | Per-log feedback comments | T-04 | Team members only; comments never enter public snapshots; kept across log revisions; authors delete, owners hide |
| E-11 | GitHub App integration | T-08 | Per-repository installation linked to a project space; commits and PRs become evidence candidates for the contribution ledger (never auto-confirmed); webhook signature check and replay protection; tokens revoked on disconnect; private repository content never auto-enters public snapshots |
| E-12 | AI retrospective interview (§6.4) | T-09 | Only when the student turns it on; log drafts are saved only after student approval and marked `AI 초안`; uses only that team's data; no-training API terms; the form check-in keeps working with AI off |
| E-13 | AI meeting summary (§6.5) | T-08, E-12 | Only meeting channels the team agreed to; 🗣️ meeting log drafts (decisions, follow-ups) saved after team approval; raw conversation not stored |
| E-14 | AI case polishing (§10.3) | T-13, E-12 | Only within the visibility the student chose; every sentence cites a source log; uncited sentences are highlighted and must be fixed or removed before publishing; records `generator = ai` |
| E-15 | Short lounge videos (deferred from A-04) | A-04 | Video duration and size limits, container metadata removal (in an isolated job), short signed URLs only for readers of the post, 0 in public, social and search outputs |

Start order: E-01 → E-02 → E-03 → E-04 → E-06 → E-07 → E-08 → E-09 → E-10 → E-05 → E-11 → E-12 → E-13 → E-14. AI items (E-12–E-14) stay off without a provider key, and core features must work without AI (product plan §15).

## 5. Acceptance scenarios

**A. Recording a personal assignment without GitHub**
A student signs up with email, creates a private assignment, and leaves a PDF and a one-line log. On reconnection the materials and save state persist, and before publication they are invisible to anonymous users, other users, and the search API. There must be no empty screen that demands a GitHub connection.

**B. Recording a stuck point in Discord**
When a teammate types `/log 막힘 CORS 에러` (“/log stuck CORS error”) in Discord, exactly one 🧱 log is created in that project. Resending the same request does not create a duplicate. When another teammate adds 📌 to someone else's message, an approval request goes to the author, and no log is created before approval.

**C. Teammates confirm contributions**
A claims a role based on logs and artifacts, and B confirms it. If A edits the content or evidence, the earlier confirmation is no longer shown as valid for the current claim. Even the owner cannot edit A's claim. Peer-evaluation reports show confirmation states distinctly.

**D. Embargo and publishing shared materials**
For an assignment in a course whose term is still in progress, the server rejects publication requests. After the term ends, if the owner prepares a candidate but one person has not consented or a file is still being scanned, publication fails. If someone leaves, withdraws, or content changes right after consent but before publishing, the server recheck blocks it. Other logs in the workspace are not included in the public response.

**E. Withdrawal and derived data**
When consent for a published shared file is withdrawn, new public reads and file access are blocked immediately, and the file is excluded from portfolios, cases, search, and course aggregates. Test residual access during short URL TTLs, and explain that copies already downloaded cannot be recalled. Even if a worker fails, public reads must be blocked first.

**F. Junior students exploring a course and forking a plan**
A visitor who is not logged in sees public cases, stuck cards, and senior notes on a course page. The workload distribution is not shown if there are fewer than five contributors. When a logged-in junior student forks a plan, only milestones, checklists, time allocation, and reference materials are copied; artifacts, log bodies, and stuck-card resolutions are not.

**G. Retrospective writing**
When a graduate creates a past assignment in retrospective mode, every item and public screen shows a `Retrospective` label, and self-entered dates are distinguished from recording timestamps.

**H. Beginner recording and accessibility**
On mobile, a student can upload a file first and complete the description later. On save failure, content is not lost and a retry is shown. Every action can be done by keyboard, and states can be understood through text, not only color or icons. To-do order can be changed without dragging.

**I. Reading for hiring**
An anonymous reviewer opens a public profile without logging in and finds the problem, personal role, and evidence of the featured assignment within 90 seconds. Only the contact details the student allowed are visible. Private school information, emails, team feedback, and check-ins are not included in page HTML, JSON, Open Graph, or printed output.

### 5.1 Community acceptance scenarios (P1)

**J. Official school page visibility**
A student verified with a pilot school email reads the official school page and posts anonymously. Logged-out users, users verified with another school, and users whose verification was revoked get 404 at the same URL. No body text appears in a search engine crawler simulation or external link previews, and community posts do not mix into public search or course pages.

**K. Protecting anonymous authors**
When the poster comments on their own anonymous post, they appear as `Author`; other participants appear as `Anon 1`, `Anon 2` in order of first participation, and those numbers persist within the thread. Nothing links them by number or key to the same person's posts in other threads. Owner and moderator API responses and screens contain no author identifiers either. Anonymous posts do not appear on the author's public profile, portfolio, or activity totals.

**L. Changing the name display mode**
When an owner switches a real-name room to anonymous, all members are notified and the change takes effect 7 days later. Real-name posts written before then stay under real names; later posts are anonymous. Conversely, switching an anonymous room to real names does not reveal the authors of earlier anonymous posts. The change history is visible in room settings.

**M. Reports, temporary hiding, restrictions**
When 3 distinct verified users report a post in a user room, it is hidden immediately and queued for review. Repeated reports from the same person do not accumulate. Because the owner cannot know the anonymous author, they request a sanction; an operator records a reason, identifies the author, and issues a warning or write suspension. The identification is audited, and the restricted user can still use their own assignment spaces and portfolio.

**N. From study recruiting to records**
When a study recruiting post goes up on an official page's Recruiting board, applicant details are visible only to the recruiter and are not ranked. When recruiting closes, a study room with display names by default is created and applicants are invited. Members keep a weekly build log in the study room and, at the end, publish it as a public case with member consent. Records from anonymous study rooms cannot be linked to portfolios.

**O. Moving a question into a stuck log**
When an answer to an assignment question on the Questions board is accepted, the asker requests "Move to stuck log". Only after both the asker and the accepted answerer consent and choose the name display mode again is a copy created as a stuck log; the original post keeps its community visibility. If either declines, nothing is copied.

**P. Small anonymous rooms and impersonation**
In an anonymous room with 9 members, post times show only as "today" or "this week", and the creation screen warns about identification risk. Creating a user room with `Official` or `Student Council` in its name is rejected, and the `Official` badge appears only on spaces opened by operators.

### 5.2 Public profile and following acceptance scenarios (P1)

**Q. Anonymous posts never leak into profiles**
The owner of `@devjimin`, a display name with many followers, writes an anonymous post on the official school page and (P2) an affiliation-labeled anonymous post in a topic. Neither appears anywhere in the activity lists, following feed, recommendations, search, OG, or PDF of `@devjimin` or the real-name profile, and response JSON carries neither the post ID nor its timestamp. After the owner switches a room to real names, earlier anonymous posts still do not appear on the profile. If the same post is moved into the archive under the display name, only the copy appears on `@devjimin`, with no visible link to the original.

**R. Separating display name and real name**
With the link off, neither the display-name profile nor the real-name profile carries the other's information in HTML, JSON, OG, PDF, follow lists, or recommendations. When the user turns the link on, both show links to each other; turning it off removes them from the next request, and the toggle history remains only in the audit record. Following someone as a display name shows only the display name in their follower list.

**S. Visibility never bypasses the publication process**
Even with every item set to `Public`, publication candidates lacking team consent, private assignment spaces, and titles of embargoed assignments do not appear on the profile. The assignment list shows only course, semester, and title for projects the user picked, with no other members' names or logs. Withdrawing a public case removes it from the profile list and followers' feeds from the next request.

**T. Private accounts and following**
A follow request to a private account shows only basic information until approved; after approval, the assignment list and posts at the `approved followers` level become visible. Removing a follower does not notify them. Switching from private to public does not auto-approve pending requests but asks the owner. With follower count display off, public responses carry no number.

**U. Blocking**
When A blocks B from A's display-name profile, B gets 404 for that profile, follows between them are deleted, and no notification is sent. A's real-name profile is hidden only if A chooses "block on all profiles", which shows the link-inference warning. Anonymous posts on the official school page remain visible regardless of the block.

**V. Social link verification**
After adding the Peerchive profile link to a GitHub profile and requesting a check, `Verified` is shown. Removing the link turns it into `lost` at the next recheck. URLs redirecting to private IPs or internal addresses are refused by the fetching worker without connecting.

### 5.3 Alumni, topic, and organization acceptance scenarios (P2)

**W. Alumni and OB rooms**
In a club OB room, a member appears with the per-room profile `Kim Jimin, cohort 12` and an `OB` badge, and that name never appears on public profiles, search, or feeds outside the room. When organizers post a homecoming event, members respond going/not going/maybe, and the responder list is visible only to members. Organizer notices show only a read count, never who read them.

**X. Member directory consent**
The directory shows only members who consented, and only the fields they consented to. When a member withdraws consent or leaves, their entry disappears immediately. There is no way to export the directory as CSV or PDF or read it all at once, and paging through many pages quickly hits a rate limit.

**Y. Affiliation label threshold**
A graduate of a bootcamp with 30 verified members posting in the `Job hunting` topic is labeled `Bootcamp graduate`, and only the author is told that the label was broadened. An alumnus of a university with 60 or more verified alumni is labeled `○○ Univ. · Alumni`. If the author chooses `None`, no affiliation is shown. Later growth in members or a change of affiliation never alters labels on existing posts, and departments and cohorts are never shown.

**Z. Organization verification methods and organization admins**
Expired invite codes and codes over their use limit are rejected. A cohort whose organization does not participate is verified by approval from 2 members of the same cohort, and approvals from members verified only by cohort approval do not count. For certificate checks, the file is deleted right after the decision and a deletion record remains. Organization admins cannot learn the authors of anonymous or affiliation-labeled anonymous posts on their organization page, and cannot query affiliated users' profiles or assignment spaces by organization.

## 6. Measurement plan

**North star metric:** among assignments and senior notes published at the end of the term, **the number that junior students forked as a plan or marked “This helped”** (hypothesized pilot-term target: 15).

The key author-side metric is **the number of students who left meaningful logs during the period and connected contribution evidence to a portfolio**. We check the usefulness of records rather than increase activity volume.

| Metric | Definition | Draft pilot interpretation |
|---|---|---|
| Activation | Within 7 days of signup: create an assignment + 3 logs + one piece of evidence | 50–60% of invited students |
| Recording retention | Share of active students who record in at least 3 of 4 weeks | 40%; examine exam-period effects separately |
| In-term value | Teams that actually used the contribution report for peer evaluation or presentations | 30% |
| Case conversion | Share of completed assignments confirmed as publishable that are published (summary or above) | 30–40% |
| Helped discovery | Share of current students who, after visiting a course page, marked a stuck card or senior note “This helped” or forked a plan | 30% |
| Supply conversion | Share of helped students who left their own notes or stuck cards at the end of the term | 20% |
| Portfolio use | Students who connected a public case as a featured contribution and actually shared it | 10 or more (pilot), 20 (stage 3) |
| Understanding | Share of simulated reviewers who accurately explain role, result, and evidence | 80% |
| Writing burden | Actual time to write one log and reasons for abandonment | Median 5 minutes or less |
| Operational safety | Private leaks, incorrect publication, deletion failures | Halt expansion if any serious unresolved case exists |
| Cost | Storage, transfer, worker, AI cost, and operator hours per active student | Factor into estimating the next scope |

Minimal analytics events: `project_created`, `log_saved` (tag, source), `evidence_attached`, `milestone_snapshot_set`, `checkin_submitted`, `claim_endorsed`, `report_exported`, `candidate_prepared`, `consent_completed`, `publication_published`, `publication_withdrawn`, `plan_forked`, `usefulness_marked`, `senior_note_published`, `portfolio_shared`. Events do not contain assignment bodies, file contents, raw search text, or contact details. Pilot consent, retention periods, and analytics access permissions are explained separately.

Public view counts, likes, and commit counts are not used as personal capability scores. Ratios from small samples are not generalized to the entire university student market, and improving employment rates is a separate long-term research question that an early pilot cannot prove.

### 6.1 Community metrics (P1)

The community succeeds not by time spent but by whether **questions and study groups in the community lead into archive records**. These metrics decide product plan §19's rule, "if almost nothing moves from the community into records, keep only recruiting and study rooms".

| Metric | Definition | Draft judgment for one pilot term |
|---|---|---|
| **Community → stuck log conversion** (core) | Share and count of technical and assignment questions on Questions boards moved into stuck logs or stuck Q&A | At least 10% of questions or 20 items. Below 5% counts as "almost nothing" |
| **Community → study record conversion** (core) | Share of closed study recruitments whose study room kept a build log for at least 3 weeks | At least 30%. Below 10%, keep recruiting only and drop study records |
| Study publication | Share of recorded study groups that became public cases or senior notes at term end | 20% |
| Recruiting success | Share of recruiting posts closed with a study room or assignment space created | 40% |
| Archive entry | Share of community users who opened a course hub or their own assignment space for the first time | 30% |
| Return visits | Share of school-verified users visiting at least weekly during the term (exam periods tracked separately) | 30% |
| Report rate and handling time | Reports per 1,000 posts; median time from auto-hide to completed review | Median review within 24 hours |
| Moderation load | Weekly report review hours for operators and moderators | Within the hours available per product plan §19 question 10 |
| Author identification | Number of operator author identifications and share linked to a report | 100% linked to reports, zero unlinked lookups |

Community analytics events: `community_post_created` (space_kind, name_mode, board_kind), `community_comment_created`, `archive_transfer_requested`, `archive_transfer_completed` (target), `recruitment_closed` (kind), `study_room_created`, `study_record_logged`, `report_filed`, `post_auto_hidden`, `sanction_issued` (level), `operator_identity_lookup`. **Events for anonymous posts and comments carry no user key**, and conversion metrics count only users who consented at the moment of conversion. Bodies, titles, and space names are never included in events. Like counts and post counts are not used as personal metrics.

### 6.2 Public profile, following, alumni, and organization metrics (P1, P2)

Public profiles and following succeed not by follower counts but by **whether following leads to reading and writing records**; alumni and organization expansion succeeds by **whether the supply of senior notes and public cases grows**. These metrics decide the change conditions in product plan §19 for the identity position, display names, follower counts, affiliation labels, and alumni spaces.

| Metric | Definition | Draft judgment |
|---|---|---|
| **Identity leaks** (required) | Count of level 0–1 posts found in profiles, feeds, follows, recommendations, search, OG, or PDF, or of personas with a private link shown together | Zero. Any single case stops the feed and profile features until the cause is fixed |
| **Following → record use** (core, P1) | Share of users who open a public case or senior note from the following feed and leave "Helpful" or fork | 15% of feed users. Below 5%, reduce the feed to profile subscription notifications |
| Feed composition | Share of records (cases, senior notes, study records) among feed items shown | At least 50%. If photo-centric profile posts are the majority, adjust media weight |
| Non-anonymous activity share (P1) | Share of community posts written under display or real names (levels 2–3) and activity in spaces other than anonymous lounges | If there is almost no activity outside anonymous lounges (under 10%), revisit the weight of anonymous spaces per product plan §19 |
| Display name use | Share of public profile holders who created a display-name persona, and who turned on the link | Observation only (no target) |
| Display-name impersonation and reputation laundering | Impersonation or deception reports against display-name profiles, and confirmed cases | If confirmed cases recur, require an organization verification badge on display-name profiles per §19 |
| Follower count display choice | Share of users showing follower counts; creator interview results | Evidence for the §19 change condition (important for attracting creators) |
| Social link referrals | Users with verified social links and visits arriving through external links | Observation only |
| Blocks, mutes, follower removals | Occurrences per 1,000 active follow relationships | If they spike, review recommendation and exposure |
| **Alumni → senior note supply** (core, P2) | Share and count of alumni in alumni and OB rooms or topics who left a senior note or completion retrospective during the term | 10% or at least 30 items is evidence for moving alumni spaces up to P1 per §19 |
| Topic → senior note conversion (P2) | Share of answers in role topics moved into senior notes | 5% |
| Alumni room activity (P2) | Share of alumni rooms with at least one event or notice per month; RSVP rate per event | 40%, 30% |
| Directory consent rate (P2) | Share of alumni room members who consented to the directory | Observation only (never forced, even if low) |
| Affiliation label broadening rate (P2) | Share of topic posts broadened by the threshold | If it is the majority, revisit the threshold for pilot scale (§19) |
| Organization verification (P2) | Count and processing time per verification method; verifications found to be impersonation | Median certificate review within 3 days; review approval paths when impersonation is confirmed |
| Organization supply (P2) | Public cases and portfolios that started in organization cohort rooms | Evidence for the organization sales hypothesis (product plan §17) |

Analytics events: `persona_created` (kind), `identity_link_toggled`, `visibility_changed` (item_kind, audience), `project_listed`, `follow_requested`, `follow_approved`, `follower_removed`, `block_created` (scope), `mute_created`, `feed_item_opened` (source_type), `social_link_verified`, and for P2 `alumni_room_created`, `event_created`, `rsvp_submitted`, `directory_consent_changed`, `topic_post_created` (label_scope_applied, broadened), `affiliation_verified` (method), `completion_retro_published`. Events for level 0–1 posts carry no user key, and block, mute, and follower removal events carry no key for the other person. Follower counts and feed impressions are never used as personal metrics or rankings.

## 7. Release and expansion gates

| Gate | Required checks | If failed |
|---|---|---|
| **G0: Direction** | Use E0–E5 to judge the hypotheses for in-term recording, contribution ledger, course hub, and portfolio | Adjust product scope, then reduce development |
| **G1: private alpha** | Authorization, persistence, file quarantine, account state, and bot collection tests; use by two internal teams | Do not accept external users |
| **G2: limited public** | Publication consent, embargo, withdrawal, derivative blocking, reports, and recovery work; report handler, response time, and deletion procedure designated | Block public features; re-verify after fixing |
| **G3: Next cohort** | Review recording burden, student value, publication policy, operating cost | Adjust purpose of use or recruitment scope |
| **GC: Community launch** | G3 passed; C-05 and C-06 regression tests (visibility, author non-disclosure, auto-hide); report reviewer, weekly hours, and response time assigned; at least 2 moderators at the pilot school; takedown request procedure legally reviewed; community rules announced | Do not open the community; open only recruiting and study rooms in a limited way, or hold |
| **GP: Public profiles and following launch** | G2 passed; S-02 regression tests (zero identity leaks); S-03 visibility and S-04 block 404 tests; personas and profile posts included as report targets; display-name impersonation handling criteria announced | Do not open following or the feed; stay at the public profile link level |
| **GA: Alumni, topics, organizations** | GC passed with §6.1 conversion evidence; A-03 directory, A-05 threshold, and extended S-02 regression tests; an alumni group or partner organization to open with (product plan §19 questions 12 and 13); certificate file deletion procedure and organization admin scope reviewed | Keep only the alumni boards and lounges of existing official pages |
| **G4: Employer and institution expansion** | Supply of consenting users, repeated review demand, contact and data policies confirmed | Stay at the public profile link level |

Separate feature completion from operational readiness. Writing down a legal or school-policy review in a document does not make it complete.

## 8. Cold start and growth

Split supply units smaller than full cases to gather initial content quickly.

| Supply unit | Writing-time hypothesis | Initial target (per course) |
|---|---|---|
| Senior note | 10 minutes | 10 |
| Stuck card (retrospective) | 5 minutes each | 20 |
| Retrospective case | 30 minutes | 3–5 |
| In-progress case | Throughout the term | 5–10 pilot teams |

- **Sequence:** 2026-12 graduate campaign → course pages opened at the start of the 2027-03 term (bringing in current students) → in-term recording → publication after the 2027-06 term ends → portfolio sharing during the second-half recruitment season → new visitors via shared links.
- **Channels:** department student councils, development and design clubs, capstone presentations, graduation project exhibitions. University email verification is not required as a condition of entry.
- **Density:** Focus on 2–3 courses rather than a whole school. When search results are sparse, show collections by course and type instead of a popularity feed, and supplement with “At other schools” (concept tags).
- Include cases with failures and constraints in the initial public content, so the structure does not benefit only students who showcase well.
- **ProofU as the first case:** The owner publishes ProofU itself as the first public case in retrospective mode (marking that the 2019 commits are a reconstructed record).

## 9. Risks and responses

| Risk | Early signal | Response |
|---|---|---|
| Recording fatigue | Sharp drop in logs after 2–3 weeks, missing attachments | Increase the share of bot, check-ins, and AI interviews; reduce tags; files first |
| Becoming an answer collection | Many artifact downloads but few log views; searches for problem numbers and answers | Encourage summary publication, embargo, make assignment context/approach/validation the basic unit, operate reporting |
| Contribution ledger used as a conflict tool | Claim disputes, blaming comments | No scores or rankings, factual-recording guide, appeals, separation of personal claims and confirmations |
| Portfolio exaggeration | Mismatch between role claims and evidence | Distinct confirmation states, revisions, withdrawal and appeals, mandatory citations |
| Team consent obstacles | Publication delayed by nonresponse | Agree on publication scope early in the term, exclude non-consenting members' materials, use personally permitted materials |
| Cold start | Course pages are empty | Graduate campaign, course focus, retrospective writing, operator interview ghostwriting (with approval) |
| Only accomplished students participate | Cases concentrate among skilled students | Templates for failures and small assignments, senior notes, optional sensitive fields |
| Messenger mismatch | Target students don't use Discord | Shift to web/PWA quick log, KakaoTalk notifications |
| AI cost and hallucination | Cost spikes, sentences without evidence | Template drafts first, per-task model separation, caching and limits, mandatory citations, evaluation set |
| Solo developer delays | Exceeding 13 weeks | Boldly defer P1 and below, apply the reduced scope. Do not cut publication or authorization tests |
| Time sunk into legacy code | Experiments delayed while only fixing installation and dependency issues | Preserve originals; time-box running the original for exhibition to 2–3 days |
| Pushback from schools or professors | Opposition to publishing specific courses | Embargo, summary publication, faculty request channel (P2), per-class policies |
| External API dependence | Connection failures, switch to private, quotas | Links first, adapters and retry, usable without integrations |
| Weak employer demand | Shared links are not actually read | Keep the value of student recording and organization; defer employer features |

### 9.1 Community moderation risks (P1)

The community carries a far heavier operating load than the archive. Open only what a solo developer and a small moderation team can handle.

| Risk | Early signal | Response |
|---|---|---|
| Report review exceeds capacity | Growing review backlog, median handling time over 24 hours, weekly review hours above what is available | Keep automatic temporary hiding, first-pass review by moderators, limit user room capacity and new room creation, narrow anonymous rooms to verified owners and capped capacity (product plan §19), and if still overloaded, pause writing on the official page |
| Anonymous harassment, doxxing | Real names or contact details of specific people, repeated reports about the same target | Rules against naming and doxxing, no anonymous DMs, staged restrictions, consider pulling forward the real-name and contact warning (P2) |
| Cannot recruit moderators | Fewer than 2 moderator volunteers at the pilot school | Limit to one official page that operators can run directly; user rooms rely on owner responsibility plus operator report handling |
| Abuse of, or distrust in, operator author identification | Lookups not linked to reports, user inquiries | Limit the permission to the report-handling role, require a reason and report ID, review audit logs regularly, disclose on the writing screen |
| Identification in small anonymous rooms | "I know who wrote this" reports in small anonymous rooms | Time buckets for rooms under 10 members, warning at creation, restrict anonymity for small rooms if needed |
| School or department impersonation | Names resembling `Official` or student councils, outsiders on department pages | Reject reserved words, keep the `Official` badge separate, department moderators restrict outsiders' writing, consider department council confirmation if repeated (no student ID collection) |
| Answer sharing, academic misconduct | Reports of code or answers shared in course-linked rooms during the same term | Embargo policy for course-linked rooms, categorized report reasons, plan and concept questions allowed |
| Takedown and legal requests | Rights infringement claims, law enforcement requests | Finalize a legally reviewed separate procedure before GC, keep handling records |
| Community replaces the archive instead of leading into it | Post counts grow but §6.1 conversion metrics stay low | Make "Move to stuck log" more prominent on Questions boards; if conversion stays low, keep only recruiting and study rooms and shrink the free boards |
| Competing with existing communities, empty spaces | Only conversations already on Everytime repeat, visits decline | Focus on uses that lead to records, such as study recruiting and assignment questions; never create empty official pages in advance. If opening requests are too few, operators open the page first at the single pilot school only (product plan §19) |

### 9.2 Public profile, following, alumni, and organization expansion risks (P1, P2)

| Risk | Early signal | Response |
|---|---|---|
| Anonymous posts joined to profiles | Regression tests or reports find level 0–1 posts in profiles or feeds; reports inferring "this display name wrote that anonymous post" from timing or style | Zero identity leaks rule (§6.2), stop feed and profile features on discovery, strengthen the S-02 boundary (module lint, DB grants, property tests), widen time buckets for small spaces |
| Persona link inferred through blocks or visibility | Questions or reports that "these two profiles seem to be the same person" | Keep the default block scope to that persona, warn when choosing `all_personas` or `same_institution`, regression-test response differences related to the link |
| Display-name impersonation and reputation laundering | Display names imitating other people or organizations; reappearing under a new display name after reports | Impersonation report reason, limits on display name changes, sanctions applied per account, require an organization verification badge on display-name profiles if it recurs (product plan §19) |
| Follower competition and show-off feeds | Spike in users showing follower counts; photo-centric profile posts become the majority of the feed | No popularity ranking, no follower-count sorting or recommendation weight, records first in the feed, limits on media per profile post |
| Misunderstanding visibility settings | Questions like "I set everything public but my case isn't shown" or "it's private but visible by link" | Preview on the settings screen showing the relation to the publication process and public URLs; when switching to private, explain that published releases need a separate withdrawal |
| Abuse of social link checks | Attempts to reach internal addresses; `Verified` mistaken for identity verification | SSRF defenses in the link-fetching worker, limits on recheck frequency and count, explanatory text for `Verified` |
| Small affiliation labels breaking anonymity | Reports of "I know who that is" in small organizations or cohorts | Keep or raise the threshold of 50, never show departments or cohorts, broaden that affiliation's label in bulk on reports |
| Harvesting and spam from member directories | Spike in directory reads; reports of promotion or spam via directory contacts | Consented fields only, no export, rate limits, owner removal and operator sanctions on reports |
| Fake cohorts and organization impersonation | Growth in accounts verified by approval chains; bulk approvals by the same approver | Approvers verified only by non-approval methods, 2 approvals required, approver records, approval rights restricted when impersonation is confirmed |
| Organization admins as surveillance tools | Organizations asking to view affiliated users' activity or identify anonymous authors | No API to query users by organization, author identification only for the operator report-handling role, stated in organization agreements (G4) |
| Reputation disputes with organizations | Completion retrospectives used as de facto ratings or defamation; organizations demanding deletion | No star ratings or salaries, structured retrospective format, rule against naming and defaming individuals, takedown request procedure (GC) |
| Alumni spaces stay purely social | Alumni rooms are active but the §6.2 supply metrics are low | Surface senior note requests and the completion retrospective format in alumni rooms; if it stays low, shrink P2 scope to events and directories |
| Alumni room moderation load and storage cost | Growth in album and video storage; more reports | Per-room storage limits, external links first for video, included in cost estimation (§10) |

## 10. Operating cost estimation approach

Because the hosting provider, region, capacity, and pricing have not been chosen, monthly costs are not presented as fixed numbers. Recalculate against official prices at the time a provider is selected.

- Fixed: web, worker, and bot runtime, PostgreSQL, monitoring, authentication and email
- Variable: storage, download transfer, scanning/thumbnail/PDF jobs, AI tokens, external API calls
- People: publication guidance, reports and disputes, interviews, file and DB recovery, deployment management, community report review and moderator support (P1, weekly hours recorded separately)

An initial 50 students × 500MB assumes up to roughly 25GB of original data; derivative files, versions, backups, and transfer are additional. Prefer external links for video, and set per-student limits and overall budget alerts. If budget is short, cut AI, automatic GitHub connection, sophisticated PDFs, and semantic search first, while keeping private authorization, file quarantine, publication withdrawal, and recovery.

## 11. Git, archive, and documentation practices

- Preserve the original `frontend/`, `backend/`, `docs/history-map.json`, and `docs/archive-cleanup.json`. If a separate request requires modifying originals, record the change and verification criteria explicitly.
- Carry out new implementation on feature branches (e.g., `peerchive/<feature>`), and keep tests, migrations, and operational documentation inside the new `apps/` and `packages/`. Do not rewrite master history or change the backup branch.
- For each implementation unit, record the problem, user behavior, completion criteria, authorization impact, and tests in the PR. The README labels features as “proposed / in development / available.”
- Update this document according to experiment results, and record major decisions as ADRs.
- The 18 commits dated 2019 are a reconstruction of code uploaded in 2020, not actual development logs from that time. The new service does not present that record as real-time development evidence or contribution certification. Retain the [original history backup](https://github.com/polynomeer/peerchive/tree/backup/pre-reconstruction-20261013).

## 12. Immediate next steps (two weeks from 2026-10-19)

1. Finalize the interview questionnaire (§2.1) and recruit candidate current students, hiring reviewers, and faculty.
2. Build the Notion build log template (tags, milestones, check-in form) and the Discord channel structure, and recruit 2–3 E0 pilot teams.
3. Choose the first 2–3 courses and ask 5 graduates for senior notes, stuck cards, and retrospective write-ups (E2).
4. Create static mockups of the course page, public case, and public profile for use in E1 and E4.
5. Prepare the 2019 milestone snapshots for the first case using screenshots of the original ProofU screens and history materials.
6. Set up a Nuxt + PostgreSQL + Drizzle + pg-boss skeleton and CI (including original-preservation checks) as a technical experiment, and record ADRs.

This order is meant to confirm which records are actually useful to students, rather than building a “nice-looking site” first. Recruiting and contacting students, signing up for external services, and deployment are not part of this documentation work.
