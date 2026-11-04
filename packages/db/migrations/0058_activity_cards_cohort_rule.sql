-- ADR 0060 D-11: 표 기반 일치 테스트(apps/web/test/persona-activity-parity.integration.test.ts)가 찾은 차이를 고칩니다.
-- 기수 방(I-02)은 canReadSpace가 "그 기관·그 기수의 active 인증"을 요구하는데(meetsRoomAffiliation → hasCohortAffiliation), 0031의 SQL은 기수 방이 생기기 전이라
-- 같은 기관의 어떤 인증이든 통과시켰습니다. 그 방의 active 멤버로 남은 채 다른 기수 인증만 가진 사람에게 글 제목·방 이름 카드가 나갔습니다. 함수 전체를 같은 내용으로 바꾸고 이 조건만 더합니다.
-- 시그니처가 같아 실행 권한(0031 REVOKE, peerchive_social GRANT)은 그대로입니다.
CREATE OR REPLACE FUNCTION "public"."persona_activity_cards"(p_viewer uuid, p_ids uuid[])
  RETURNS TABLE(activity_id uuid, title text, body text, href text, context text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH act AS (
    SELECT a.id, a.persona_id, a.source_type::text AS source_type, a.source_id
    FROM "public"."persona_activities" a
      JOIN "public"."personas" p ON p.id = a.persona_id
      JOIN "public"."users" u ON u.id = p.user_id
      JOIN "public"."profiles" pr ON pr.persona_id = p.id
    WHERE a.id = ANY(p_ids) AND a.withdrawn_at IS NULL AND p.status::text = 'active' AND u.status::text = 'active' AND pr.hidden_at IS NULL
      AND "public"."persona_activity_source_ok"(a.persona_id, a.source_type, a.source_id)
  ),
  viewer_schools AS (
    SELECT coalesce(sc.merged_into, sc.id) AS school_id, ia.cohort_id
    FROM "public"."institution_affiliations" ia JOIN "public"."schools" sc ON sc.id = ia.school_id
    WHERE p_viewer IS NOT NULL AND ia.user_id = p_viewer AND ia.status::text = 'active'
  ),
  viewer AS (
    SELECT (p_viewer IS NOT NULL AND EXISTS (SELECT 1 FROM "public"."users" vu WHERE vu.id = p_viewer AND vu.status::text = 'active')) AS active,
           EXISTS (SELECT 1 FROM "public"."operators" o WHERE o.user_id = p_viewer AND o.revoked_at IS NULL) AS operator,
           EXISTS (SELECT 1 FROM viewer_schools) AS any_school
  )
  SELECT act.id, NULL::text, pp.body, NULL::text, NULL::text
    FROM act JOIN "public"."profile_posts" pp ON pp.id = act.source_id
    WHERE act.source_type = 'profile_post'
  UNION ALL
  SELECT act.id, cp.title, NULL::text, '/community/p/' || cp.id::text, s.name
    FROM act JOIN "public"."community_posts" cp ON cp.id = act.source_id
      JOIN "public"."community_spaces" s ON s.id = cp.space_id
      LEFT JOIN "public"."schools" ssc ON ssc.id = s.school_id
      CROSS JOIN viewer v
    WHERE act.source_type = 'community_post' AND v.active AND (
      (s.kind::text IN ('official_school', 'official_department')
        AND (v.operator OR (s.school_id IS NOT NULL AND coalesce(ssc.merged_into, ssc.id) IN (SELECT school_id FROM viewer_schools))))
      OR (s.kind::text IN ('user_room', 'study_room')
        AND EXISTS (SELECT 1 FROM "public"."space_memberships" m WHERE m.space_id = s.id AND m.user_id = p_viewer AND m.status::text = 'active')
        AND (CASE
          WHEN s.cohort_id IS NOT NULL THEN EXISTS (SELECT 1 FROM viewer_schools vs WHERE vs.school_id = coalesce(ssc.merged_into, ssc.id) AND vs.cohort_id = s.cohort_id)
          WHEN s.school_id IS NULL THEN v.any_school
          ELSE coalesce(ssc.merged_into, ssc.id) IN (SELECT school_id FROM viewer_schools)
        END))
    )
  UNION ALL
  SELECT act.id, coalesce((SELECT cc.title FROM "public"."courses" cc WHERE cc.id = c.merged_into), c.title), NULL::text, '/c/' || n.course_id::text, n.term_label
    FROM act JOIN "public"."senior_notes" n ON n.id = act.source_id
      JOIN "public"."courses" c ON c.id = n.course_id
    WHERE act.source_type = 'senior_note'
  UNION ALL
  SELECT act.id, rc.snapshot->>'title', left(rc.snapshot->>'summary', 200), '/p/' || pub.slug, rc.term_label
    FROM act JOIN "public"."publication_candidates" rc ON rc.id = act.source_id
      JOIN "public"."publications" pub ON pub.id = rc.publication_id
    WHERE act.source_type IN ('publication_release', 'study_release') AND pub.status::text = 'published' AND pub.current_release_id = rc.id
$$;
