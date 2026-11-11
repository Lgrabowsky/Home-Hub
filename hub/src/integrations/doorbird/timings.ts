/**
 * Every interval, timeout and limit of the DoorBird integration in one place.
 *
 * The defaults are what runs in production. Tests pass shorter values through
 * the integration's constructor instead of sleeping for seconds.
 */
export interface DoorBirdTimings {
  /** Timeout of a normal API call (info, door opener, light, opening the event stream). */
  requestTimeoutMs: number;
  /** Timeout of `image.cgi`. */
  imageTimeoutMs: number;
  /** Timeout of `history.cgi` — the device fetches these pictures from DoorBird's cloud, which can be slow. */
  historyTimeoutMs: number;
  /** Pause before the single retry after an HTTP 503 ("busy"). */
  busyRetryMs: number;

  /** First retry of `info.cgi` while a device has never answered (the poller backs off from here up to 60 s). */
  infoRetryMs: number;
  /** How often `info.cgi` is re-read while an app is open / while nobody is looking. */
  infoRefreshActiveMs: number;
  infoRefreshIdleMs: number;
  /** `info.cgi` doubles as reachability probe at this rate while the event stream is not connected. */
  probeMs: number;
  /** Two failed contacts must lie at least this far apart before a device counts as unreachable. */
  offlineAfterMs: number;

  /** Wait after the device refused the login (401/423). Doubles with every further refusal up to the maximum. */
  authRetryMinMs: number;
  authRetryMaxMs: number;
  /** A single function that was refused although the login works is not asked again for this long. */
  deniedCooldownMs: number;

  /** Reconnect delay of the event stream: starts at the minimum and doubles up to the maximum. */
  monitorBackoffMinMs: number;
  monitorBackoffMaxMs: number;
  /** A stream that lived at least this long resets the reconnect delay. */
  monitorStableMs: number;
  /** The device repeats its state about every 20 s; a stream silent for this long is considered dead. */
  monitorIdleMs: number;
  /** A first "H" within this time after connecting is the device's initial state dump, not a new event. */
  monitorGraceMs: number;
  /** Wait after HTTP 509 (all event streams of the device are in use). */
  monitorBusyWaitMs: number;
  /** Wait after HTTP 404/204 on the event stream (not supported / not permitted). */
  monitorUnsupportedWaitMs: number;

  /** A second ring within this time is the same press (contact bounce). */
  ringDebounceMs: number;
  /** Motion is recorded at most once per this interval. */
  motionIntervalMs: number;
  /** A picture this fresh is reused for an event instead of asking the device again. */
  eventImageMaxAgeMs: number;

  /** `snapshot()` answers from memory for this long. */
  snapshotCacheMs: number;
  /** A failed snapshot is not retried for this long (several apps may be asking at once). */
  snapshotErrorCacheMs: number;
  /** A second opening of the same relay within this time is refused (accidental double tap). */
  openGuardMs: number;

  /** History sync: delay after a device became reachable, delay after a live event, regular interval. */
  historyStartDelayMs: number;
  historyEventDelayMs: number;
  historyIntervalMs: number;
  /** Retry after a history sync that was cut short by an error. */
  historyRetryMs: number;
  /** Next attempt after the device said the user may not read the history. */
  historyDeniedRetryMs: number;
  /** Minimum distance between a history download and the previous request to the same device. */
  historyGapMs: number;
  /** The device keeps this many pictures per event type. */
  historyMaxIndex: number;
  /** A history picture this close to an event the hub recorded itself is the same event. */
  dedupeWindowMs: number;

  /** How often old events are deleted. */
  retentionIntervalMs: number;
  /** Upper bound of stored events per door (protects the disk when a motion sensor fires all day). */
  maxEventsPerDoor: number;
}

export const DOORBIRD_DEFAULTS: Readonly<DoorBirdTimings> = Object.freeze({
  requestTimeoutMs: 8_000,
  imageTimeoutMs: 10_000,
  historyTimeoutMs: 15_000,
  busyRetryMs: 1_200,

  infoRetryMs: 2_000,
  infoRefreshActiveMs: 10 * 60_000,
  infoRefreshIdleMs: 30 * 60_000,
  probeMs: 60_000,
  offlineAfterMs: 2_500,

  authRetryMinMs: 5 * 60_000,
  authRetryMaxMs: 30 * 60_000,
  deniedCooldownMs: 60_000,

  monitorBackoffMinMs: 2_000,
  monitorBackoffMaxMs: 30_000,
  monitorStableMs: 30_000,
  monitorIdleMs: 60_000,
  monitorGraceMs: 5_000,
  monitorBusyWaitMs: 60_000,
  monitorUnsupportedWaitMs: 10 * 60_000,

  ringDebounceMs: 3_000,
  motionIntervalMs: 30_000,
  eventImageMaxAgeMs: 1_000,

  snapshotCacheMs: 1_500,
  snapshotErrorCacheMs: 2_000,
  openGuardMs: 2_000,

  historyStartDelayMs: 10_000,
  historyEventDelayMs: 8_000,
  historyIntervalMs: 30 * 60_000,
  historyRetryMs: 5 * 60_000,
  historyDeniedRetryMs: 6 * 60 * 60_000,
  historyGapMs: 1_100,
  historyMaxIndex: 50,
  dedupeWindowMs: 20_000,

  retentionIntervalMs: 24 * 60 * 60_000,
  maxEventsPerDoor: 10_000,
});

/** Constructor options of the integration: any subset of the timings. */
export type DoorBirdOptions = Partial<DoorBirdTimings>;
