// App code tells the mascot what is happening ("ask-start", "quiz-correct", ...) without depending on it.
// If no mascot is mounted, or it is off, nothing listens and nothing happens.
export function mascotSignal(type, detail = {}) {
  try { window.dispatchEvent(new CustomEvent('sparkscribe:mascot', { detail: { type, ...detail } })); } catch { /* never affects the app */ }
}

// Called right before navigating to another SparkScribe page, so the mascot can "follow" (it runs in from
// the left on the next page instead of simply reappearing).
export function mascotTravel() {
  try { sessionStorage.setItem('sparkscribe.mascot.travel', String(Date.now())); } catch { /* fine */ }
}
