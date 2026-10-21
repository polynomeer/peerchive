# Peerchive delivery plan and validation criteria

[한국어](DELIVERY_PLAN.md) | **English**

Written: 2026-10-18 · Updated: 2026-10-20 (campus community in §4.1, §5.1, §6.1, §9.1, and gate GC) · Status: consolidated proposal

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
| **4. Expansion** | 2027 fall term onward | Multiple departments and schools, Kanban board, GitHub App, stuck-card Q&A, semantic search, campus community (one pilot school, §4.1), class spaces, monetization experiments | – | **GC** (community launch), **G4** |

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

## 7. Release and expansion gates

| Gate | Required checks | If failed |
|---|---|---|
| **G0: Direction** | Use E0–E5 to judge the hypotheses for in-term recording, contribution ledger, course hub, and portfolio | Adjust product scope, then reduce development |
| **G1: private alpha** | Authorization, persistence, file quarantine, account state, and bot collection tests; use by two internal teams | Do not accept external users |
| **G2: limited public** | Publication consent, embargo, withdrawal, derivative blocking, reports, and recovery work; report handler, response time, and deletion procedure designated | Block public features; re-verify after fixing |
| **G3: Next cohort** | Review recording burden, student value, publication policy, operating cost | Adjust purpose of use or recruitment scope |
| **GC: Community launch** | G3 passed; C-05 and C-06 regression tests (visibility, author non-disclosure, auto-hide); report reviewer, weekly hours, and response time assigned; at least 2 moderators at the pilot school; takedown request procedure legally reviewed; community rules announced | Do not open the community; open only recruiting and study rooms in a limited way, or hold |
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
