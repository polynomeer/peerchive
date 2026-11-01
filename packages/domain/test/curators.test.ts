import { describe, expect, it } from 'vitest'
import { COURSE_CURATOR_LIMIT, CURATOR_REVIEW_TARGETS, curatorEligibility, isCuratorReviewTarget } from '../src'

const OK = { userActive: true, alreadyCurator: false, activeCurators: 0, finishedCourse: true, verifiedForSchool: true }

describe('student curator eligibility (E-03)', () => {
  it('needs an active account, a free seat (max 2), a finished course and an active school verification', () => {
    expect(COURSE_CURATOR_LIMIT).toBe(2)
    expect(curatorEligibility(OK)).toEqual({ ok: true })
    expect(curatorEligibility({ ...OK, activeCurators: 1 })).toEqual({ ok: true })
    expect(curatorEligibility({ ...OK, activeCurators: 2 })).toEqual({ ok: false, error: 'limit_reached' })
    expect(curatorEligibility({ ...OK, finishedCourse: false })).toEqual({ ok: false, error: 'not_finished' })
    expect(curatorEligibility({ ...OK, verifiedForSchool: false })).toEqual({ ok: false, error: 'not_verified' })
    expect(curatorEligibility({ ...OK, alreadyCurator: true, activeCurators: 2 })).toEqual({ ok: false, error: 'already_curator' })
    expect(curatorEligibility({ ...OK, userActive: false, finishedCourse: false })).toEqual({ ok: false, error: 'inactive' })
  })

  it('reviews only reports on course hub items (notes, Q&A, public cases)', () => {
    expect([...CURATOR_REVIEW_TARGETS]).toEqual(['senior_note', 'course_qa', 'publication', 'publication_item'])
    expect(isCuratorReviewTarget('course_qa')).toBe(true)
    for (const t of ['case_study', 'profile', 'persona', 'community_post', 'room_item']) expect(isCuratorReviewTarget(t)).toBe(false)
  })
})
