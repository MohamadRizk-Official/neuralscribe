// The SparkScribe mark (Direction 1, "Audio Spark"): a waveform whose center bar is a lightning bolt.
// At rest it is still; in the header it gives a quiet bolt flash every 10 s (CSS). sparkPulse() plays the
// full interaction once: the bolt flashes and a pulse runs outward through the bars (about 1.2 s).
// (The class is "is-sparking", not "pulse": .pulse is the site-wide cyan status dot, and borrowing it
// turned the logo into a glowing cyan disc while it animated.)
// Everything is CSS animation, so "reduce motion" (style.css) turns it all off.

export function sparkPulse(root = document) {
  root.querySelectorAll('.spark-mark').forEach((m) => {
    m.classList.remove('is-sparking');
    void m.getBoundingClientRect(); // restart the animation if it is already running
    m.classList.add('is-sparking');
  });
}

document.addEventListener('animationend', (e) => {
  if (e.animationName === 'spark-glow') e.target.classList?.remove('is-sparking');
});
