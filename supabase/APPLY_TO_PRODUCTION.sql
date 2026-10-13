-- =========================================================================
-- THE LAST DATASET — PRODUCTION CONSOLIDATED MIGRATIONS & RPC INSTALLER
-- TechTatva 2026 | MAHE Manipal
-- 
-- Run this script in the Supabase Dashboard SQL Editor for your project:
-- https://supabase.com/dashboard/project/bqedvdohyaeivdqzapyy/sql
-- =========================================================================

-- -------------------------------------------------------------------------
-- PART 1: HARD 2-PLAYER ROSTER LIMIT TRIGGER (MIGRATION 003)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_team_member_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_member_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_member_count
    FROM public.team_members
    WHERE team_id = NEW.team_id;

    IF v_member_count >= 2 THEN
        RAISE EXCEPTION 'TEAM_CAP_EXCEEDED: Maximum 2 players permitted per team.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_member_cap ON public.team_members;
CREATE TRIGGER trg_team_member_cap
BEFORE INSERT ON public.team_members
FOR EACH ROW
EXECUTE FUNCTION public.check_team_member_cap();


-- -------------------------------------------------------------------------
-- PART 2: ATOMIC ML QUOTA RESERVATION WITH PERMANENT ESCAPE LOCK (MIGRATIONS 002/003)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_ml_attempt(
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_raw_filename TEXT DEFAULT 'submission.csv',
    p_max_attempts INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_count INTEGER;
    v_new_id UUID;
    v_now TIMESTAMPTZ := NOW();
    v_already_escaped BOOLEAN := FALSE;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    -- Take a transaction-level advisory lock on the team hash
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- Check if team has already qualified or completed purple zone
    SELECT EXISTS (
        SELECT 1 FROM public.ml_submissions
        WHERE team_id = v_clean_team_id AND qualifies_for_escape = TRUE
    ) OR EXISTS (
        SELECT 1 FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = 'purple' AND status = 'completed'
    ) INTO v_already_escaped;

    -- Count existing attempts
    SELECT COUNT(*) INTO v_count
    FROM public.ml_submissions
    WHERE team_id = v_clean_team_id;

    -- If already escaped, permanently lock submissions
    IF v_already_escaped THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'submissionId', NULL,
            'attemptNumber', v_count,
            'submissionsUsed', v_count,
            'submissionsRemaining', 0,
            'alreadyCompleted', TRUE,
            'reason', 'PURPLE_ALREADY_COMPLETED',
            'submittedAt', v_now
        );
    END IF;

    -- Check if quota exhausted
    IF v_count >= p_max_attempts THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'submissionId', NULL,
            'attemptNumber', v_count,
            'submissionsUsed', v_count,
            'submissionsRemaining', 0,
            'alreadyCompleted', FALSE,
            'reason', 'SUBMISSION_LIMIT_EXCEEDED',
            'submittedAt', v_now
        );
    END IF;

    -- Insert pending submission record
    INSERT INTO public.ml_submissions (
        team_id,
        delegate_id,
        status,
        raw_filename,
        submitted_at
    )
    VALUES (
        v_clean_team_id,
        p_delegate_id,
        'pending',
        COALESCE(p_raw_filename, 'submission.csv'),
        v_now
    )
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'allowed', TRUE,
        'submissionId', v_new_id,
        'attemptNumber', v_count + 1,
        'submissionsUsed', v_count + 1,
        'submissionsRemaining', GREATEST(0, p_max_attempts - (v_count + 1)),
        'alreadyCompleted', FALSE,
        'submittedAt', v_now
    );
END;
$$;


-- -------------------------------------------------------------------------
-- PART 3: ATOMIC QUALIFYING ML SUBMISSION & 1,000-POINT PURPLE COMPLETION (MIGRATION 003)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_qualifying_ml_submission(
    p_submission_id UUID,
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_r2_score DOUBLE PRECISION DEFAULT NULL,
    p_mse_score DOUBLE PRECISION DEFAULT NULL,
    p_points INTEGER DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_now TIMESTAMPTZ := NOW();
    v_idempotency_key TEXT;
    v_points_awarded INTEGER := 0;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    v_idempotency_key := v_clean_team_id || ':purple-escape';

    -- 1. Take advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- 2. Finalize submission to valid and qualifying
    UPDATE public.ml_submissions
    SET r2_score = p_r2_score,
        mse_score = p_mse_score,
        qualifies_for_escape = TRUE,
        status = 'valid',
        error_message = NULL
    WHERE id = p_submission_id AND team_id = v_clean_team_id;

    -- 3. Mark purple zone completed
    INSERT INTO public.zone_progress (team_id, zone_id, status, completed_at, updated_at)
    VALUES (v_clean_team_id, 'purple', 'completed', v_now, v_now)
    ON CONFLICT (team_id, zone_id) DO UPDATE
    SET status = 'completed',
        completed_at = COALESCE(public.zone_progress.completed_at, v_now),
        updated_at = v_now;

    -- 4. Award 1,000 points idempotently in score ledger
    BEGIN
        INSERT INTO public.score_ledger (
            team_id,
            delegate_id,
            points,
            source_type,
            source_id,
            idempotency_key,
            created_at
        )
        VALUES (
            v_clean_team_id,
            p_delegate_id,
            COALESCE(p_points, 1000),
            'zone_purple_clear',
            'purple-escape',
            v_idempotency_key,
            v_now
        );
        v_points_awarded := COALESCE(p_points, 1000);
    EXCEPTION WHEN unique_violation THEN
        v_points_awarded := 0; -- Already awarded
    END;

    RETURN jsonb_build_object(
        'success', TRUE,
        'submissionId', p_submission_id,
        'teamId', v_clean_team_id,
        'zoneCompleted', TRUE,
        'pointsAwarded', v_points_awarded,
        'qualifiesForEscape', TRUE,
        'finalizedAt', v_now
    );
END;
$$;


-- -------------------------------------------------------------------------
-- PART 4: ATOMIC CROSS-ZONE COMPLETION STORED PROCEDURE (MIGRATION 004)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_zone_atomic(
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_zone_id TEXT DEFAULT NULL,
    p_points INTEGER DEFAULT 0,
    p_next_zone_id TEXT DEFAULT NULL,
    p_dataset_key TEXT DEFAULT NULL,
    p_source_id TEXT DEFAULT NULL,
    p_source_type TEXT DEFAULT NULL,
    p_required_prev_zone TEXT DEFAULT NULL,
    p_required_challenges TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_now TIMESTAMPTZ := NOW();
    v_prev_status TEXT;
    v_solved_challenges TEXT[];
    v_req_challenge TEXT;
    v_has_qual BOOLEAN := FALSE;
    v_already_completed BOOLEAN := FALSE;
    v_idempotency_key TEXT;
    v_points_awarded INTEGER := 0;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    IF p_zone_id IS NULL OR p_zone_id = '' THEN
        RAISE EXCEPTION 'Zone ID is required';
    END IF;

    -- 1. Take transaction-level advisory lock on team zone completion
    PERFORM pg_advisory_xact_lock(hashtext('zone_complete:' || v_clean_team_id));

    -- 2. Validate prerequisite zone
    IF p_required_prev_zone IS NOT NULL THEN
        SELECT status INTO v_prev_status
        FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = p_required_prev_zone;

        IF v_prev_status IS NULL OR v_prev_status != 'completed' THEN
            RAISE EXCEPTION 'PREREQUISITE_NOT_MET: Previous sector "%" must be completed before "%" can be cleared.', p_required_prev_zone, p_zone_id;
        END IF;
    END IF;

    -- 3. Validate required challenges
    IF array_length(p_required_challenges, 1) > 0 AND p_zone_id != 'purple' THEN
        SELECT solved_challenges INTO v_solved_challenges
        FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;

        FOREACH v_req_challenge IN ARRAY p_required_challenges LOOP
            IF v_solved_challenges IS NULL OR NOT (v_req_challenge = ANY(v_solved_challenges)) THEN
                RAISE EXCEPTION 'CHALLENGES_INCOMPLETE: Sector "%" requires challenge "%" to be solved before clearance.', p_zone_id, v_req_challenge;
            END IF;
        END LOOP;
    END IF;

    -- 4. Purple zone requires qualifying ML submission
    IF p_zone_id = 'purple' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.ml_submissions
            WHERE team_id = v_clean_team_id AND qualifies_for_escape = TRUE
        ) INTO v_has_qual;

        IF NOT v_has_qual THEN
            RAISE EXCEPTION 'PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.';
        END IF;
    END IF;

    -- 5. Check if zone is already completed
    SELECT (status = 'completed') INTO v_already_completed
    FROM public.zone_progress
    WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;

    -- 6. Mark current zone completed
    INSERT INTO public.zone_progress (
        team_id,
        zone_id,
        status,
        completed_at,
        updated_at
    )
    VALUES (
        v_clean_team_id,
        p_zone_id,
        'completed',
        v_now,
        v_now
    )
    ON CONFLICT (team_id, zone_id) DO UPDATE
    SET status = 'completed',
        completed_at = COALESCE(public.zone_progress.completed_at, v_now),
        updated_at = v_now;

    -- 7. Unlock next zone if specified
    IF p_next_zone_id IS NOT NULL THEN
        INSERT INTO public.zone_progress (
            team_id,
            zone_id,
            status,
            unlocked_at,
            updated_at
        )
        VALUES (
            v_clean_team_id,
            p_next_zone_id,
            'available',
            v_now,
            v_now
        )
        ON CONFLICT (team_id, zone_id) DO UPDATE
        SET status = CASE WHEN public.zone_progress.status = 'completed' THEN 'completed' ELSE 'available' END,
            unlocked_at = COALESCE(public.zone_progress.unlocked_at, v_now),
            updated_at = v_now;
    END IF;

    -- 8. Grant dataset entitlement if specified
    IF p_dataset_key IS NOT NULL THEN
        INSERT INTO public.dataset_entitlements (
            team_id,
            dataset_key
        )
        VALUES (
            v_clean_team_id,
            p_dataset_key
        )
        ON CONFLICT (team_id, dataset_key) DO NOTHING;
    END IF;

    -- 9. Award points idempotently in score ledger
    IF p_points > 0 THEN
        v_idempotency_key := v_clean_team_id || ':' || COALESCE(p_source_id, p_zone_id);
        BEGIN
            INSERT INTO public.score_ledger (
                team_id,
                delegate_id,
                points,
                source_type,
                source_id,
                idempotency_key,
                created_at
            )
            VALUES (
                v_clean_team_id,
                p_delegate_id,
                p_points,
                COALESCE(p_source_type, 'zone_' || p_zone_id || '_clear'),
                COALESCE(p_source_id, p_zone_id),
                v_idempotency_key,
                v_now
            );
            v_points_awarded := p_points;
        EXCEPTION WHEN unique_violation THEN
            v_points_awarded := 0; -- Already awarded previously
        END;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'teamId', v_clean_team_id,
        'zoneId', p_zone_id,
        'nextZoneId', p_next_zone_id,
        'datasetKey', p_dataset_key,
        'pointsAwarded', v_points_awarded,
        'alreadyCompleted', COALESCE(v_already_completed, FALSE),
        'completedAt', v_now
    );
END;
$$;


-- -------------------------------------------------------------------------
-- PART 5: RESET SEEDED TEAMS TO FAIR COMPETITION STATE
-- Sets Sanctuary as 'available' (unlocked) and all later zones as 'locked'
-- -------------------------------------------------------------------------
DELETE FROM public.score_ledger;
DELETE FROM public.dataset_entitlements;
DELETE FROM public.ml_submissions;

UPDATE public.zone_progress
SET status = 'available',
    unlocked_at = NOW(),
    completed_at = NULL,
    solved_challenges = '{}'
WHERE zone_id = 'sanctuary';

UPDATE public.zone_progress
SET status = 'locked',
    unlocked_at = NULL,
    completed_at = NULL,
    solved_challenges = '{}'
WHERE zone_id != 'sanctuary';

-- Grant execute permissions to postgres and service_role
GRANT EXECUTE ON FUNCTION public.reserve_ml_attempt TO postgres, service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.finalize_qualifying_ml_submission TO postgres, service_role, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.complete_zone_atomic TO postgres, service_role, authenticated, anon;
