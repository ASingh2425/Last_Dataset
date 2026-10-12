-- =========================================================================
-- THE LAST DATASET — MIGRATION 002: ATOMIC ML QUOTA RESERVATION
-- TechTatva 2026 | MAHE Manipal
-- Multi-instance advisory lock and atomic quota reservation
-- =========================================================================

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
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    -- 1. Take a transaction-level advisory lock on the team hash
    -- This serializes concurrent evaluation requests for the same team across all database connections / Lambdas.
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- 2. Count existing attempts
    SELECT COUNT(*) INTO v_count
    FROM public.ml_submissions
    WHERE team_id = v_clean_team_id;

    -- 3. Check if quota exceeded
    IF v_count >= p_max_attempts THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'submissionId', NULL,
            'attemptNumber', v_count,
            'submissionsUsed', v_count,
            'submissionsRemaining', 0,
            'submittedAt', v_now
        );
    END IF;

    -- 4. Insert pending submission record
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

    -- 5. Return success payload
    RETURN jsonb_build_object(
        'allowed', TRUE,
        'submissionId', v_new_id,
        'attemptNumber', v_count + 1,
        'submissionsUsed', v_count + 1,
        'submissionsRemaining', GREATEST(0, p_max_attempts - (v_count + 1)),
        'submittedAt', v_now
    );
END;
$$;
