const crypto = require('node:crypto');
const { supabase } = require('./supabaseClient');

function hashPassword(passcode) {
  return crypto.createHash('sha256').update(String(passcode).trim(), 'utf8').digest('hex');
}

/**
 * Authoritative Supabase Store for The Last Dataset.
 */
class SupabaseStore {
  /**
   * Authenticates a team player using Team ID, Delegate ID, and Passcode.
   */
  async authenticatePlayer({ teamId, delegateId, passcode }) {
    const normalizedTeamId = String(teamId || '').trim().toUpperCase();
    const normalizedDelegateId = String(delegateId || '').trim();
    const cleanPasscode = String(passcode || '').trim();

    if (!normalizedTeamId || !normalizedDelegateId || !cleanPasscode) {
      return { success: false, error: 'Team ID, Delegate ID, and Password are all required.' };
    }

    // 1. Fetch team
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('id', normalizedTeamId)
      .eq('is_active', true)
      .maybeSingle();

    if (teamError || !team) {
      return { success: false, error: 'Team ID not found or inactive.' };
    }

    // 2. Verify password hash
    const inputHash = hashPassword(cleanPasscode);
    if (inputHash !== team.passcode_hash) {
      return { success: false, error: 'Invalid password for this team.' };
    }

    // 3. Verify delegate ID belongs to this team
    const { data: member, error: memberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('team_id', normalizedTeamId)
      .eq('delegate_id', normalizedDelegateId)
      .maybeSingle();

    if (memberError || !member) {
      return { success: false, error: `Delegate ID ${normalizedDelegateId} is not registered to ${normalizedTeamId}.` };
    }

    // 4. Create session (64 hex characters to match security.js regex)
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: sessionError } = await supabase
      .from('team_sessions')
      .insert({
        session_id: sessionId,
        team_id: normalizedTeamId,
        delegate_id: normalizedDelegateId,
        expires_at: expiresAt
      });

    if (sessionError) {
      return { success: false, error: 'Could not create session.' };
    }

    return {
      success: true,
      sessionId,
      team,
      member
    };
  }

  /**
   * Validates an active session cookie.
   */
  async validateSession(sessionId) {
    if (!sessionId) return null;

    const { data: session, error } = await supabase
      .from('team_sessions')
      .select('*, teams(*), team_members(*)')
      .eq('session_id', sessionId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !session || !session.teams) return null;

    // Refresh last active timestamp asynchronously
    supabase
      .from('team_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('session_id', sessionId)
      .then(() => {});

    return {
      sessionId: session.session_id,
      teamId: session.team_id,
      delegateId: session.delegate_id,
      team: session.teams,
      member: session.team_members
    };
  }

  /**
   * Destroys a session on logout.
   */
  async destroySession(sessionId) {
    if (!sessionId) return;
    await supabase.from('team_sessions').delete().eq('session_id', sessionId);
  }

  /**
   * Retrieves full team bootstrap state including scores, zones, and members.
   */
  async getTeamBootstrap(teamId, delegateId, config) {
    // 1. Fetch team & members
    const { data: team } = await supabase.from('teams').select('*').eq('id', teamId).single();
    const { data: members } = await supabase.from('team_members').select('*').eq('team_id', teamId);

    // 2. Fetch score
    const { data: scoreRows } = await supabase.from('score_ledger').select('points').eq('team_id', teamId);
    const totalScore = (scoreRows || []).reduce((acc, row) => acc + (row.points || 0), 0);

    // 3. Fetch zone progress
    const { data: zoneRows } = await supabase.from('zone_progress').select('*').eq('team_id', teamId);
    const progressMap = new Map((zoneRows || []).map((z) => [z.zone_id, z]));

    // 4. Fetch dataset entitlements
    const { data: entitlements } = await supabase.from('dataset_entitlements').select('*').eq('team_id', teamId);
    const earnedDatasets = (entitlements || []).map((e) => e.dataset_key);

    // 5. Best ML score & Escape Gate status
    const { data: submissions } = await supabase
      .from('ml_submissions')
      .select('r2_score, qualifies_for_escape')
      .eq('team_id', teamId)
      .order('r2_score', { ascending: false })
      .limit(1);

    const bestR2 = submissions && submissions[0] ? submissions[0].r2_score : null;
    const escapeUnlocked = submissions && submissions[0] ? submissions[0].qualifies_for_escape : false;

    // Sanctuary completion prerequisite
    const sanctuaryProgress = progressMap.get('sanctuary');
    const isSanctuaryCompleted = sanctuaryProgress?.status === 'completed';

    // 6. Map zones matching UI structure
    const zones = config.zones.map((zone, index) => {
      const zProgress = progressMap.get(zone.id);
      const solvedList = zProgress?.solved_challenges || [];
      const solvedCount = solvedList.length;
      const isCleared = zProgress?.status === 'completed' || solvedCount >= zone.ctfs.length;

      // Yellow Zone (index === 0) ONLY unlocks once Sanctuary has been completed!
      let isUnlocked = false;
      if (index === 0) {
        isUnlocked = isSanctuaryCompleted && (zProgress?.status === 'available' || zProgress?.status === 'in_progress' || isCleared);
      } else {
        isUnlocked = zProgress?.status === 'available' || zProgress?.status === 'in_progress' || isCleared;
      }

      const state = isCleared ? 'cleared' : isUnlocked ? (solvedCount > 0 ? 'in-progress' : 'available') : 'locked';

      return {
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved: solvedCount,
        solvedCtfs: solvedList,
        state,
        unlocked: isUnlocked,
        isFinal: index === config.zones.length - 1
      };
    });

    const totalFragments = 4;
    const recoveredFragments = earnedDatasets.length;

    return {
      authenticated: true,
      teamId: team.id,
      team: {
        id: team.id,
        name: team.team_name,
        leader: team.team_leader_name,
        studentType: team.student_type,
        members: members || []
      },
      player: {
        delegateId
      },
      score: {
        total: totalScore
      },
      progress: {
        solved: recoveredFragments,
        total: totalFragments,
        ratio: totalFragments ? recoveredFragments / totalFragments : 0,
        complete: recoveredFragments >= totalFragments
      },
      sanctuaryCompleted: isSanctuaryCompleted,
      zones,
      datasets: earnedDatasets,
      ml: {
        bestR2,
        escapeUnlocked
      },
      event: config.event,
      serverTime: new Date().toISOString()
    };
  }

  /**
   * Completes a challenge atomically using PostgreSQL RPC.
   */
  async completeChallenge({
    teamId,
    delegateId,
    zoneId,
    challengeId,
    points,
    allZoneChallenges,
    nextZoneId,
    rewardDatasetKey
  }) {
    const { data, error } = await supabase.rpc('complete_challenge_idempotent', {
      p_team_id: teamId,
      p_delegate_id: delegateId || null,
      p_zone_id: zoneId,
      p_challenge_id: challengeId,
      p_points: points || 20,
      p_all_zone_challenges: allZoneChallenges,
      p_next_zone_id: nextZoneId || null,
      p_reward_dataset_key: rewardDatasetKey || null
    });

    if (error) {
      throw new Error(`Atomic challenge completion failed: ${error.message}`);
    }

    return data;
  }

  /**
   * Completes an entire zone directly and unlocks the next zone + dataset entitlement.
   */
  async completeZoneDirect({ teamId, delegateId, zoneId }) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required');
    const now = new Date().toISOString();

    const zoneConfigs = {
      sanctuary: { nextZoneId: 'yellow', datasetKey: null, points: 10, source: 'sanctuary_complete', sourceId: 'sanctuary-gate' },
      yellow: { nextZoneId: 'blue', datasetKey: 'community_final', points: 100, source: 'zone_yellow_clear', sourceId: 'yellow-zone' },
      blue: { nextZoneId: 'orange', datasetKey: 'radio_final', points: 400, source: 'zone_blue_clear', sourceId: 'blue-zone' },
      orange: { nextZoneId: 'red', datasetKey: 'forensics_final', points: 20, source: 'zone_orange_clear', sourceId: 'orange-zone' },
      red: { nextZoneId: 'purple', datasetKey: 'research_final', points: 20, source: 'zone_red_clear', sourceId: 'red-zone' },
      purple: { nextZoneId: null, datasetKey: null, points: 500, source: 'zone_purple_clear', sourceId: 'purple-escape' }
    };

    const cfg = zoneConfigs[zoneId];
    if (!cfg) throw new Error(`Unknown zone ${zoneId}`);

    // 1. Mark zone completed
    await supabase
      .from('zone_progress')
      .upsert({
        team_id: cleanTeamId,
        zone_id: zoneId,
        status: 'completed',
        completed_at: now,
        updated_at: now
      }, { onConflict: 'team_id,zone_id' });

    // 2. Mark next zone available
    if (cfg.nextZoneId) {
      await supabase
        .from('zone_progress')
        .upsert({
          team_id: cleanTeamId,
          zone_id: cfg.nextZoneId,
          status: 'available',
          unlocked_at: now,
          updated_at: now
        }, { onConflict: 'team_id,zone_id' });
    }

    // 3. Grant dataset entitlement if applicable
    if (cfg.datasetKey) {
      await supabase
        .from('dataset_entitlements')
        .upsert({
          team_id: cleanTeamId,
          dataset_key: cfg.datasetKey
        }, { onConflict: 'team_id,dataset_key' });
    }

    // 4. Award points idempotently
    if (cfg.points > 0) {
      try {
        await supabase
          .from('score_ledger')
          .insert({
            team_id: cleanTeamId,
            points: cfg.points,
            source_type: cfg.source,
            source_id: cfg.sourceId,
            idempotency_key: `${cleanTeamId}:${cfg.sourceId}`,
            created_at: now
          });
      } catch (_) {}
    }

    return { ok: true, zoneId, nextZoneId: cfg.nextZoneId, datasetKey: cfg.datasetKey };
  }

  /**
   * Fetch team directly by Team ID.
   */
  async getTeamDirect(teamId) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) return null;
    const { data: team, error } = await supabase
      .from('teams')
      .select('*')
      .eq('id', cleanTeamId)
      .maybeSingle();
    if (error || !team) return null;
    return team;
  }

  /**
   * Checks if team has unlocked entitlement to a dataset fragment.
   */
  async checkDatasetEntitlement(teamId, datasetKey) {
    const { data, error } = await supabase
      .from('dataset_entitlements')
      .select('*')
      .eq('team_id', teamId)
      .eq('dataset_key', datasetKey)
      .maybeSingle();

    if (error || !data) return false;

    // Increment download count
    supabase
      .from('dataset_entitlements')
      .update({ download_count: (data.download_count || 0) + 1 })
      .eq('team_id', teamId)
      .eq('dataset_key', datasetKey)
      .then(() => {});

    return true;
  }

  /**
   * Records an ML submission and evaluation result.
   */
  async recordMlSubmission({
    teamId,
    delegateId,
    r2Score,
    mseScore,
    qualifiesForEscape,
    status,
    errorMessage,
    rawFilename
  }) {
    const { data, error } = await supabase
      .from('ml_submissions')
      .insert({
        team_id: teamId,
        delegate_id: delegateId || null,
        r2_score: r2Score,
        mse_score: mseScore,
        qualifies_for_escape: qualifiesForEscape,
        status,
        error_message: errorMessage || null,
        raw_filename: rawFilename || 'submission.csv'
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to record submission: ${error.message}`);
    }

    return data;
  }

  /**
   * Fetches the live leaderboard.
   */
  async getLeaderboard() {
    const { data, error } = await supabase
      .from('leaderboard_view')
      .select('*')
      .limit(100);

    if (error) {
      throw new Error(`Failed to load leaderboard: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Fetches submission history for a specific team.
   */
  async getTeamSubmissions(teamId) {
    if (!teamId) return [];
    const { data, error } = await supabase
      .from('ml_submissions')
      .select('*')
      .eq('team_id', teamId)
      .order('submitted_at', { ascending: false })
      .limit(25);

    if (error) {
      throw new Error(`Failed to load submissions: ${error.message}`);
    }

    return data || [];
  }
}

const supabaseStore = new SupabaseStore();
module.exports = { supabaseStore };
