// ── Countdown timer for simulator mode ───────────────────────

let _interval = null;
let _endsAt = null;

export function startTimer(seconds, onTick, onExpire) {
  stopTimer();
  _endsAt = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((_endsAt - Date.now()) / 1000));
    onTick(left);
    if (left <= 0) {
      stopTimer();
      onExpire();
    }
  };
  tick();
  _interval = setInterval(tick, 1000);
}

export function stopTimer() {
  if (_interval) clearInterval(_interval);
  _interval = null;
  _endsAt = null;
}

export function secondsLeft() {
  return _endsAt ? Math.max(0, Math.round((_endsAt - Date.now()) / 1000)) : null;
}

export function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
