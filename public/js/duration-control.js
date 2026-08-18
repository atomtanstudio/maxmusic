/**
 * Shared duration-grid behavior for the Simple/Create and Studio screens.
 *
 * The model still receives seconds. This module only standardises the quick
 * selection surface: half-minute steps from 0:30 through the normal 5:00
 * maximum. Exact typed values remain supported by the screens for drafts that
 * already use them or need finer control.
 *
 * Positions are reported as a plain 0–1 fraction of the range rather than as a
 * percentage of the control's width. A range input's thumb does not travel the
 * whole track: its centre runs from half a thumb in to half a thumb short of
 * the far end. The stylesheet turns the fraction into that geometry once, so
 * the painted progress, the thumb and the printed scale all agree.
 *
 * @module duration-control
 */

import { clock } from './pacing.js';

export const DURATION_GRID_MIN = 30;
export const DURATION_GRID_MAX = 300;
export const DURATION_GRID_STEP = 30;

/* The lengths worth printing under the track, each drawn at its own value.
   1:00 sits close enough to the 0:30 end that a narrow control cannot fit
   both, so it is the one that stands down. */
const DURATION_GRID_MARKS = [
  { seconds: 30 },
  { seconds: 60, optional: true },
  { seconds: 120 },
  { seconds: 180 },
  { seconds: 240 },
  { seconds: 300 },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Where a length sits along the track, as a fraction from 0 to 1. */
function gridFraction(seconds) {
  return clamp(
    (Number(seconds) - DURATION_GRID_MIN) / (DURATION_GRID_MAX - DURATION_GRID_MIN),
    0,
    1,
  );
}

/** Snap a value to the nearest half-minute position on the quick selector. */
export function durationGridValue(value, fallback = 120) {
  const n = Number(value);
  const source = Number.isFinite(n) ? n : Number(fallback);
  const safe = Number.isFinite(source) ? source : 120;
  const steps = Math.round((safe - DURATION_GRID_MIN) / DURATION_GRID_STEP);
  return clamp(
    DURATION_GRID_MIN + (steps * DURATION_GRID_STEP),
    DURATION_GRID_MIN,
    DURATION_GRID_MAX,
  );
}

/** Whether a value can be represented exactly by the quick selector. */
export function isDurationGridValue(value) {
  const n = Number(value);
  return Number.isFinite(n)
    && n >= DURATION_GRID_MIN
    && n <= DURATION_GRID_MAX
    && (n - DURATION_GRID_MIN) % DURATION_GRID_STEP === 0;
}

/** The `--range-pos` a screen sets so the track paints under the thumb. */
export function durationGridPosition(value) {
  return String(gridFraction(durationGridValue(value)));
}

/** Every length the slider can stop on, in order. */
export function durationGridSteps() {
  const steps = [];
  for (let s = DURATION_GRID_MIN; s <= DURATION_GRID_MAX; s += DURATION_GRID_STEP) steps.push(s);
  return steps;
}

/** Markup shared by both duration controls. */
export function durationGridMarkup({ ariaLabel = 'Song length in 30-second steps' } = {}) {
  // A tick for every length the thumb can stop on, not just for the lengths
  // there is room to name. Half-minute steps between labelled minutes had
  // nothing to line up against, which reads as a slider that does not land
  // where it says it does even when the arithmetic is exact.
  const ticks = durationGridSteps()
    .map((seconds) => `<i style="--at:${gridFraction(seconds)}"`
      + `${seconds % 60 === 0 ? ' data-minute' : ''}></i>`)
    .join('');
  const scale = DURATION_GRID_MARKS
    .map(({ seconds, optional }) => `<span style="--at:${gridFraction(seconds)}"`
      + `${optional ? ' data-optional' : ''}>${clock(seconds)}</span>`)
    .join('');
  return `
    <div class="duration-control">
      <input class="range duration-control__range" type="range"
        min="${DURATION_GRID_MIN}" max="${DURATION_GRID_MAX}" step="${DURATION_GRID_STEP}"
        value="120" data-duration-slider aria-label="${ariaLabel}">
      <div class="duration-control__ticks" aria-hidden="true">${ticks}</div>
      <div class="duration-control__scale" aria-hidden="true">${scale}</div>
    </div>`;
}
