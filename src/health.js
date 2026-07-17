const ALERT_META_KEY = "last_alert_at";
const ALERT_INTERVAL_MS = 60 * 60 * 1000;

function firstErrorLine(error) {
  return String(error?.message ?? error ?? "unknown error").split(/\r?\n/, 1)[0];
}

export function createHealthMonitor(database, options = {}) {
  const toastSender = options.toastSender;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console.log;
  const errorLogger = options.errorLogger ?? console.error;
  let consecutiveFailures = 0;

  function sendDownAlert(error) {
    try {
      const current = now();
      const currentTime = current instanceof Date ? current : new Date(current);
      const lastAlertValue = database.getMeta(ALERT_META_KEY);
      const lastAlertTime = lastAlertValue ? new Date(lastAlertValue).getTime() : NaN;
      if (
        Number.isFinite(lastAlertTime) &&
        currentTime.getTime() - lastAlertTime < ALERT_INTERVAL_MS
      ) {
        return false;
      }
      toastSender(
        "bsky sync is down",
        `${firstErrorLine(error)}\ncheck data\\syncer.log`,
      );
      database.setMeta(ALERT_META_KEY, currentTime.toISOString());
      return true;
    } catch (alertError) {
      errorLogger(`[health] alert failed: ${alertError.message}`);
      return false;
    }
  }

  return {
    get consecutiveFailures() {
      return consecutiveFailures;
    },
    recordFailure(error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        sendDownAlert(error);
      }
      return consecutiveFailures;
    },
    recordSuccess() {
      if (consecutiveFailures > 0) {
        logger(`[health] recovered after ${consecutiveFailures} failed polls`);
        consecutiveFailures = 0;
      }
    },
    alertStartupFailure(error) {
      return sendDownAlert(error);
    },
  };
}
