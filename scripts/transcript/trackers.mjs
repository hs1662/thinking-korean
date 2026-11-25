export const DEFAULT_COOLDOWN_INVOCATIONS = 2;
export const MAX_CONSECUTIVE_FAILED_THINKING = 2;
export const MAX_CONSECUTIVE_FAILED_UI = 2;

export function createFieldTracker() {
  return {
    hasPendingMarker: false,
    markerFailed: false,
    responsesSinceMarker: 0,
    consecutiveFailed: 0,
  };
}

export function resetFieldTracker(tracker) {
  tracker.hasPendingMarker = false;
  tracker.markerFailed = false;
  tracker.responsesSinceMarker = 0;
  tracker.consecutiveFailed = 0;
}

export function isFieldCapped(field, tracker, { maxConsecutiveFailedThinking, maxConsecutiveFailedUi }) {
  if (field === "thinking") {
    return tracker.consecutiveFailed >= maxConsecutiveFailedThinking;
  }
  if (field === "ui") {
    return tracker.consecutiveFailed >= maxConsecutiveFailedUi;
  }
  return false;
}

export function requiredCooldownFor(tracker, baseCooldown) {
  if (baseCooldown <= 0) {
    return 0;
  }
  const exponent = Math.max(0, tracker.consecutiveFailed - 1);
  return baseCooldown * 2 ** exponent;
}

export function isFieldInCooldown(tracker, baseCooldown) {
  if (!tracker.hasPendingMarker) {
    return false;
  }
  return tracker.responsesSinceMarker <= requiredCooldownFor(tracker, baseCooldown);
}

export function getActionableFields(driftedFields, trackers, baseCooldown, caps) {
  return driftedFields.filter((field) => {
    const tracker = trackers[field];
    if (!tracker) {
      return false;
    }
    if (isFieldCapped(field, tracker, caps)) {
      return false;
    }
    return !isFieldInCooldown(tracker, baseCooldown);
  });
}
