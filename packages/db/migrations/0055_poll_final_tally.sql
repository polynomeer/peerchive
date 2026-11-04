ALTER TABLE "room_polls" ADD COLUMN "final_tally" integer[];--> statement-breakpoint
ALTER TABLE "room_polls" ADD CONSTRAINT "room_polls_final_tally_check" CHECK ("room_polls"."final_tally" is null or cardinality("room_polls"."final_tally") = cardinality("room_polls"."options"));--> statement-breakpoint
-- ADR 0060 D-03: 이미 마감한 투표의 결과를 지금 표 수로 고정합니다(열린 투표는 그대로 null).
UPDATE "room_polls" p
SET "final_tally" = (
  SELECT array_agg(coalesce(c.n, 0) ORDER BY g.i)::integer[]
  FROM generate_series(0, cardinality(p."options") - 1) AS g(i)
  LEFT JOIN (
    SELECT v."option_index", count(*)::integer AS n FROM "room_poll_votes" v WHERE v."poll_id" = p."id" GROUP BY v."option_index"
  ) c ON c."option_index" = g.i
)
WHERE p."closes_at" <= now();
