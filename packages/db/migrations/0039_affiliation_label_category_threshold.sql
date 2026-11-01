-- A-05 소속 표시 두 단계 임계값(ADR 0042 §4): 기관이 적으면 기관 종류로, 넓힌 범주(기관 종류, 신분)도 적으면 표시 안 함(none)으로 넓힙니다.
-- 고른 범위보다 좁게 표시하지 않는 규칙은 그대로이고, institution → none·institution_kind → none을 더 허용합니다. 0038이 이미 적용된 DB를 손으로 고치지 않도록
-- 0038을 바꾸지 않고 별도 migration으로 둡니다. 새 enum 값을 쓰지 않으므로(affiliation_label_scope는 0038에서 만든 타입) text 비교가 필요 없습니다.
ALTER TABLE "community_comments" DROP CONSTRAINT "community_comments_label_scope_check";--> statement-breakpoint
ALTER TABLE "community_posts" DROP CONSTRAINT "community_posts_label_scope_check";--> statement-breakpoint
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_label_scope_check" CHECK ("community_comments"."label_scope_applied" is null or "community_comments"."label_scope_applied" = "community_comments"."label_scope_requested"
        or ("community_comments"."label_scope_requested" = 'institution' and "community_comments"."label_scope_applied" in ('institution_kind', 'none'))
        or ("community_comments"."label_scope_requested" = 'institution_kind' and "community_comments"."label_scope_applied" = 'none'));--> statement-breakpoint
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_label_scope_check" CHECK ("community_posts"."label_scope_applied" is null or "community_posts"."label_scope_applied" = "community_posts"."label_scope_requested"
        or ("community_posts"."label_scope_requested" = 'institution' and "community_posts"."label_scope_applied" in ('institution_kind', 'none'))
        or ("community_posts"."label_scope_requested" = 'institution_kind' and "community_posts"."label_scope_applied" = 'none'));