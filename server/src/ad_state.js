/**
 * Shared, cluster-safe ad-break state + command fan-out (Section 4).
 *
 * The legacy in-memory ws.setState/broadcast only reaches viewers on the SAME
 * worker. This module makes ad orchestration correct across the cluster:
 *
 *   - State lives in Redis: adstate:{channelId} (JSON, TTL'd to the break length)
 *     so ANY worker can answer "what's the ad-break state right now?" and late
 *     joiners sync regardless of which worker they land on.
 *   - Commands fan out over the Redis `ad:commands` channel. Every worker's ws
 *     hub subscribes and rebroadcasts to its local viewers (see ws.js).
 *
 * Progress (bumper / current ad / pod position) is DERIVED from startAt + pod
 * durations, so it is self-healing: no per-tick timer has to survive, and the
 * status endpoint is correct even if the triggering worker died.
 */
const { client, publish, CHANNELS } = require('./redis');

const BUMPER_DURATION_SEC = 7;
const kState = (channelId) => `adstate:${channelId}`;

/** Persist the ad-break state for a channel (TTL a bit past its end). */
async function setState(channelId, state) {
  if (!state || state.mode === 'live') {
    await client.del(kState(channelId));
    return;
  }
  let ttlSec;
  if (state.noAutoResume || !state.endAt) {
    // Full-length ad: the end time is unknown (there is no server timer). Keep
    // the state alive for a long window; it is cleared explicitly by an
    // ad.complete / error client event, or by an explicit cancel.
    ttlSec = 6 * 3600;
  } else {
    ttlSec = Math.max(10, Math.ceil(((state.endAt || Date.now()) - Date.now()) / 1000) + 15);
  }
  await client.set(kState(channelId), JSON.stringify(state), 'EX', ttlSec);
}

/** Read the raw stored state (or {mode:'live'} when nothing is active/expired). */
async function getRawState(channelId) {
  const raw = await client.get(kState(channelId));
  if (!raw) return { mode: 'live' };
  try {
    const s = JSON.parse(raw);
    // Full-length breaks have no server-side end; only an explicit ad.complete /
    // error / cancel clears them. Never time-expire those here.
    if (!s.noAutoResume && s.endAt && Date.now() > s.endAt) {
      await client.del(kState(channelId));
      return { mode: 'live' };
    }
    return s;
  } catch { return { mode: 'live' }; }
}

/**
 * Derive a rich, third-party-renderable snapshot from stored state.
 * Shapes the "we'll be right back" / current-ad / pod-progress view.
 */
async function getBreakState(channelId) {
  const s = await getRawState(channelId);
  if (s.mode !== 'pod' || !Array.isArray(s.pod) || !s.pod.length) {
    return { channel_id: channelId, state: 'live', is_ad_break: false };
  }
  const now = Date.now();
  const bumperSec = s.bumper || BUMPER_DURATION_SEC;
  const elapsedSec = Math.max(0, (now - s.startAt) / 1000);
  const totalAdSec = s.pod.reduce((a, b) => a + (b.duration || 0), 0);
  const totalSec = bumperSec + totalAdSec;
  // Full-length breaks have no known end -> remaining is unknown (null).
  // A full-length break resumes ONLY when a viewer sends ad.complete (which
  // the trigger route turns into a resume_live + state clear), never on a timer.
  const noAutoResume = !!s.noAutoResume;
  const remainingSec = noAutoResume ? null : Math.max(0, totalSec - elapsedSec);
  const breakRemaining = remainingSec === null ? null : Math.ceil(remainingSec);

  // Bumper phase ("we'll be right back").
  if (elapsedSec < bumperSec) {
    return {
      channel_id: channelId, state: 'bumper', is_ad_break: true,
      trigger_id: s.triggerId,
      full_length: noAutoResume,
      bumper: { remaining_seconds: Math.ceil(bumperSec - elapsedSec) },
      pod: { total: s.pod.length, index: 0 },
      break_remaining_seconds: breakRemaining,
    };
  }
  // Find the currently-playing ad within the pod.
  let acc = bumperSec;
  for (let i = 0; i < s.pod.length; i++) {
    const ad = s.pod[i];
    const start = acc, end = acc + (ad.duration || 0);
    const isLast = i === s.pod.length - 1;
    // For a full-length ad, its nominal duration is only a hint: once we reach
    // it we stay "playing" with unknown remaining until ad.complete arrives.
    const inThisAd = (elapsedSec >= start && elapsedSec < end) ||
                     (ad.full_length && isLast && elapsedSec >= start);
    if (inThisAd) {
      const adRemaining = ad.full_length ? null : Math.ceil(end - elapsedSec);
      return {
        channel_id: channelId, state: 'ad', is_ad_break: true,
        trigger_id: s.triggerId,
        full_length: noAutoResume,
        current_ad: {
          ad_id: ad.adId, type: ad.adType, duration_seconds: ad.duration,
          full_length: !!ad.full_length,
          elapsed_seconds: Math.floor(elapsedSec - start),
          remaining_seconds: adRemaining,
        },
        pod: { total: s.pod.length, index: i + 1 },  // human 1-based ("ad 2 of 4")
        break_remaining_seconds: breakRemaining,
      };
    }
    acc = end;
  }
  // Past the end but not yet cleaned up.
  return { channel_id: channelId, state: 'live', is_ad_break: false };
}

/** Publish a command to every worker's ws hub (cluster-wide broadcast). */
async function publishCommand(channelId, cmd) {
  await publish(CHANNELS.AD_COMMANDS, { channelId, cmd });
}

module.exports = {
  BUMPER_DURATION_SEC,
  setState, getRawState, getBreakState, publishCommand,
};
