# Peerchive evolution delivery plan and validation criteria

[한국어](DELIVERY_PLAN.md) | **English**

Peerchive is the new name for the project originating from **ProofU**, an undergraduate graduation project developed in 2019. Combining *Peer + Archive*, the name expresses a public archive where students learn from one another’s assignment and project experiences. It distinguishes this project from the separate career command center project named `proofu`. The repository address `proofu-univ` and document paths remain unchanged; the archived code is the original ProofU implementation.

Written: October 13, 2026 · Status: proposal

[Product proposal](../PROOFU_EVOLUTION_PLAN.en.md) · [System design](SYSTEM_DESIGN.en.md)

## 1. Time and staffing assumptions

This is a **16-week MVP and pilot plan** assuming one developer contributing 25–30 hours per week, one research/operations collaborator contributing 3–5 hours per week, and access to an initial student cohort. It is not a committed schedule or a report of completed research. Cohort recruitment and publication-policy review can be delayed independently of development.

Do not spend all initial time making the legacy service run. Validate demand for the proposed experience manually while building the smallest publication flow on a new application foundation. Technology, file conversion, and consent introduce uncertainty; decide whether to proceed at each stage.

At ten hours of development per week, calendar time may need to increase by roughly 2.5–3 times or more. Policies, operations, accessibility, and institutional review for a commercial launch are additional work after the pilot. If budget is tight, reduce functionality rather than omit authorization checks for file sharing and publication.

## 2. Manual experiments before development

### 2.1 Revisit the original problem

Interview 8–12 students using actual materials to follow their most recent assignment from beginning through completion and later organization. Do not require assignment-file disclosure or make private materials public for research. Ask:

- Which assignment prompted them to seek what help, from whom, and what was useful?
- Why could they not apply some reference materials, and what submission rules constrained them?
- Where did they record decisions, failures, and validation? How do they explain their role in the team outcome?
- If they have created a portfolio, how much time and rework did it require?
- What would they publish, whose consent is needed, and what makes them reluctant?

Show three student cases to 4–6 people with hiring-review experience for 90 seconds each, then ask them to explain roles, evidence, and possible interview questions. Do not infer a commitment to use the platform from an interview. Ask 2–3 instructors/mentors about actual publication conditions and concerns.

### 2.2 Case-organization experiment

Manually organize 3–5 completed assignments with consent. Compare a “Problem / My contribution / Key decision / Validation / Result / Limitations / Sources” template with simple artifact links. Use the same student materials to compare portfolio preparation time and reader understanding.

Next, run a four-week experiment in which 8–12 students record once or twice per week. Start half with free-form records and half with the three-field prompt. Treat the small sample as a way to discover obstacles rather than establish statistical proof. If attaching evidence takes too long, move links/files to the beginning of the flow.

### 2.3 Initial decision criteria

These are hypothetical thresholds for direction-setting in a small pilot. Fix measurement methods before recruitment and do not silently change thresholds to suit results.

| Hypothesis | Draft condition for proceeding | If unmet |
|---|---|---|
| Public cases help students start assignments | At least five of eight students can propose a concrete next action from a reference case | Reduce discovery scope and focus on personal records/portfolios |
| Short recording is sustainable | At least half record in three of four weeks; median writing time within five minutes | Reduce fields, prioritize files, examine automatic collection |
| Contribution explanations improve understanding | Four of five reviewers accurately explain the main role and linked evidence | Improve summary ordering and individual/team separation first |
| Publishable cases can be obtained | At least five cases with explicit consent and checked conditions | Defer that course rollout; pilot with permitted club/personal projects |

Difficulty publishing actual submissions does not require abandoning the project. Narrow initial supply to work permitted for publication after submission, club projects intended for public use, or personal reimplementations.

## 3. Phased roadmap

| Period | Goal and implementation | Deliverables | Entry criterion for next stage |
|---|---|---|---|
| Weeks 1–2 | Interviews, manual cases, core-screen prototype, small Nuxt/database/file experiments | Research summary, cases, hypothesis decisions, technical decision records | Establish recording/portfolio value or a narrower validated value |
| Weeks 3–4 | New app foundation, authentication, profiles, projects, member authorization | Reproducible local environment/CI and private spaces | Cross-user access-denial tests pass |
| Weeks 5–7 | Process records/revisions, evidence links, file quarantine, contributions | Private recording flow, scanning worker, contribution evidence | Creation/editing/reconnection preserve data; cross-team access blocked |
| Weeks 8–10 | Publication candidates, consent, publish/withdraw, public DTOs | Complete publication flow and authorization/withdrawal tests | Disclosure and withdrawal regression tests pass |
| Weeks 11–12 | Featured cases/profile presentation, minimum discovery/reporting/printing | Shareable portfolio MVP | One student completes assignment → case → portfolio |
| Weeks 13–16 | Limited pilot with 20–50 students and 5–10 teams; research, fixes, recovery drills | Metrics/interviews, incident records, next-scope decision | Continue, narrow, or pivot based on value, operations, and publication conditions |

Implement **vertical feature slices**, rather than completing every layer separately. Complete the assignment creation screen, API, database, and authorization tests together, then move on. Do not leave file scanning, authorization, and publication candidates as last-minute pilot patches.

Estimate P1 separately as 6–10 weeks after the pilot passes. Select only one or two features resolving the largest observed obstacle: Kanban, reviews, automatic GitHub connection, restricted sharing, or better PDFs. P2 employer/institution features require subsequent interviews and evidence of repeated use.

## 4. Implementation backlog and dependencies

| ID | Work | Dependencies | Completion criterion |
|---|---|---|---|
| P-01 | User research and case template | None | Document recording needs, publication obstacles, and hiring-review needs through actual cases |
| T-01 | Development environment, migrations, CI | None | Pin new runtime, reproduce deployment, run archive verification alongside app checks |
| T-02 | Sessions and public/private profiles | T-01 | Tests for account state, session expiry, CSRF, and public DTOs |
| T-03 | Assignments, invitations, project authorization | T-02 | Tests for invitation expiry, departure, ownership transfer, and cross-team access |
| T-04 | Process records and revisions | T-03 | Author permission, save failure, stale revision conflict handling |
| T-05 | Upload, quarantine, scanning | T-03 | No access/publication before clean state; limits, errors, duplicate requests handled |
| T-06 | Personal contributions and teammate confirmation | T-04, T-05 | Changed claims invalidate confirmation; others cannot edit claims |
| T-07 | Publication candidate, consent, preview | T-04–06 | Only selected versions enter DTO; manifest changes trigger consent review |
| T-08 | Publish, withdraw, block derivatives | T-07 | Transactional rechecks; anonymous access blocked immediately upon withdrawal |
| T-09 | Portfolios and personal profiles | T-08 | Select own contributions; withdrawn cases automatically blocked |
| T-10 | Discovery, reports, administrative actions | T-08 | Search public state only; actions, appeals, audit records |
| T-11 | Runbooks, recovery, pilot instrumentation | T-01–10 | Database/file recovery, deletion-ledger reapplication, analytics without personal content |
| P-02 | Pilot evaluation and scope revision | P-01, T-11 | Decide next stage from use, publication, understanding, and operating costs |

Implementation order is T-01 → T-02/T-03 → T-04 → T-05/T-06 → T-07/T-08 → T-09/T-10. These are dependencies, not a commitment to parallel agents or staffing.

## 5. User scenarios and acceptance tests

### Scenario A: personal assignment without GitHub

A student registers with email, creates a private assignment, and leaves a PDF and short entry. Files and save status survive reconnection. Before publication preparation, anonymous users, other users, and search APIs cannot see them. No empty screen requires GitHub connection.

### Scenario B: teammate confirmation

Teammate A claims a role with linked records/artifacts; B confirms it. If A changes the claim or evidence, the earlier confirmation is no longer shown as valid for the current claim. Even the owner cannot arbitrarily edit A's personal claim.

### Scenario C: publishing shared materials

The owner prepares a candidate, but publication fails if one person has not consented or a file is still being scanned. Only after all conditions pass does a public release exist; other workspace notes are absent from the public response. Server rechecks must also block publication if departure, withdrawal, or edits occur after consent but before publishing.

### Scenario D: withdrawal and derived portfolios

Withdrawal of consent for a shared public file immediately blocks new public reads/file access. Dependent portfolios, search, and PDF generation exclude it. Explain that already received copies cannot be recalled, and test residual access during short URL TTLs. Public reads must be blocked before worker processing, even when workers fail.

### Scenario E: beginner recording and accessibility

On mobile, students attach a file first and return later to explain it. Save errors retain content and offer retry. All actions work by keyboard; states are understandable through text, not just colors/icons. If Kanban is added, ordering works without dragging.

### Scenario F: employment-oriented reading

An anonymous reviewer opens a public profile without login and locates the problem, personal role, and evidence within 90 seconds. Contact details follow student permissions. Private school information, emails, and team feedback never enter HTML, JSON, Open Graph, or printed output.

## 6. Measurement plan

The initial core metric is **the number of students who leave meaningful process records during the period and connect contribution evidence to a portfolio**. Validate usefulness rather than increase activity volume alone.

| Metric | Definition | Draft pilot interpretation |
|---|---|---|
| Activation | Create assignment, first record, and one evidence item within seven days of signup | Hypothesized target of 50% of invited students |
| Recording retention | Activated students record in at least three of four weeks | Hypothesized 40% target; examine exam-period effects separately |
| Case conversion | Completed assignments explicitly permitted for publication that become cases | Denominator includes only confirmed eligible assignments; hypothetical 30% target |
| Portfolio use | Students who connect a public case to a featured contribution and actually share it | Ten or more as an initial usefulness signal |
| Understanding | Reviewers accurately explain the role, result, and evidence | Hypothesized 80% target in simulated review |
| Writing burden | Actual time per entry and reasons for abandonment | Hypothesized median within five minutes |
| Operational safety | Private leaks, incorrect publication, deletion failures | Stop expansion for serious unresolved incidents |
| Cost | Storage/transfer/worker time/operational labor per active student | Use actual costs to estimate the next scope |

Propose minimal events: `project_created`, `entry_saved`, `evidence_attached`, `candidate_prepared`, `consent_completed`, `publication_published`, `publication_withdrawn`, and `portfolio_shared`. Do not include assignment bodies, file contents, raw search queries, or contact information. Explain pilot consent, retention, and analytics access separately.

Do not turn views, likes, or commit counts into personal capability scores. Combine metrics with interviews and case-quality review; do not generalize small-sample ratios to all university students. Employment-rate improvement cannot be established by the initial pilot. It is a separate research question requiring longer-term tracking/comparison and participant consent.

## 7. Release and expansion gates

| Gate | Required checks | If failed |
|---|---|---|
| G0: direction | Validate recording/portfolio hypotheses using actual student materials | Revise product scope and reduce development |
| G1: private alpha | Authorization, persistence, file quarantine, account-state tests | Do not enable external publication |
| G2: limited public pilot | Consent, withdrawal, derivative blocking, reports, recovery | Disable public features; fix and verify again |
| G3: next cohort | Writing burden, student value, publication policy, operating cost | Adjust purpose or recruitment scope |
| G4: employer/institution expansion | Supply of consenting users, repeated review demand, contact/data policies | Remain at public profile-link sharing |

Separate feature completion from operational readiness. Before public launch, confirm report ownership, access permissions, response time, account/material deletion procedures, file backups, and recovery order. Writing down legal or school-policy review is not completion of that review.

## 8. Risks and responses

| Risk | Early signal | Response |
|---|---|---|
| Perceived as an answer collection | Finding problem numbers and answer files becomes the dominant use | Center self-written context, approach, validation; operate publication policies and reporting |
| Recording fatigue | Dropout or missing evidence after one or two entries | Short input, files first, fewer required types |
| Portfolio exaggeration | Claims/evidence mismatch or team disputes | Distinct contribution states, revisions, withdrawal, appeals |
| Team consent obstacles | Prepared cases cannot be published because of nonresponse | Agree scope early, exclude shared materials where possible, use personally permitted materials |
| Only experienced students participate | Cases concentrate among polished contributors | Failure/small-assignment templates, optional sensitive fields, mentor feedback |
| Legacy code consumes time | Installation/dependency fixes displace product experiments | Preserve originals and independently build the new core flow |
| Operating costs rise | Files, conversion, and report handling grow | Quotas, narrow formats, queues, measurement, defined support scope |
| External API dependence | Connection errors, repositories become private, quotas increase | Links first, adapters/retry, usable without automatic collection |
| Weak employer demand | Student introduction links are not actually read | Retain student organization value and defer employer search |

## 9. Operating cost and budget estimation

Providers, regions, storage, and pricing have not been selected, so do not present an unverified fixed monthly cost. Recalculate these categories against current official prices when choosing providers:

- Fixed costs: web/worker runtime, PostgreSQL, monitoring, authentication/email services.
- Variable costs: storage, download transfer, scanning/previews/PDFs, external API calls.
- Human costs: publication guidance, reports/disputes, student interviews, database/file recovery, deployment management.

Fifty initial students at a 500MB storage limit imply up to roughly 25GB of original data. Derivatives, versions, backups, and transfer are additional; this is not actual usage. Prefer external video links and configure per-student limits and overall budget alerts.

If budget is constrained, reduce automatic GitHub integration, sophisticated PDFs, search recommendations, and chat first. Private authorization, file quarantine, publication withdrawal, and recovery remain pilot requirements.

## 10. Git, archive, and documentation practices

The planning work adds documentation to the current repository. Propose subsequent implementation commits on branches such as `codex/peerchive-evolution-<feature>`. There is no reason to rewrite existing master history or change the backup branch.

Preserve `frontend/`, `backend/`, `docs/history-map.json`, and `docs/archive-cleanup.json` during modernization. If a separate request requires changing originals, record the change and verification criteria explicitly. New `apps/` and `packages/` contain their own tests, migrations, and operational documentation.

For each implementation unit, describe the problem, user behavior, completion criteria, authorization impact, and tests in the PR. README statuses distinguish “proposed,” “in development,” and “available.” Update this design with ADRs and reasons as research/experiments produce evidence.

The 18 commits dated 2019 reconstruct code uploaded in 2020; they are not actual development logs from that period. Do not present them in the new service as contemporaneous development evidence or certified personal contribution. Retain the [original history backup](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013).

## 11. Next steps

Begin with a smaller validation unit rather than implementing the entire service:

1. Select three to five recent assignments and completed projects suitable for publication, first checking use/publication consent.
2. Manually edit one representative case using the proposed template and have students/hiring reviewers read it.
3. Test short-record entry, personal contribution display, and publication preview flows.
4. Implement the technical foundation, a private assignment, and its first record as one vertical slice aligned with validated needs.
5. Start the limited pilot after authorization, publication, and withdrawal gates pass.

This sequence tests what records are actually useful to students before building an attractive site. Prototyping/application implementation, student recruitment/contact, external service registration, and deployment are outside this documentation work.
