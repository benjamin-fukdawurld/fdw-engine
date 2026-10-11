/**
 * A loop at a fixed step: the logic of the game advances by steps of the
 * same length (1/60 s), as many as the time of the frame holds, whatever
 * the rate of the screen. The same inputs then give the same game, at 30
 * or 144 frames per second.
 */
export class FixedStep {
  // The time of the frames not consumed by a step yet.
  private _pending = 0;

  constructor(
    readonly step = 1 / 60,
    // At most this many steps per frame: after a long pause, the game
    // slows down instead of running hundreds of steps at once.
    readonly maxSteps = 5
  ) {}

  /** Runs the steps a frame of `dt` seconds holds. */
  advance(dt: number, update: (step: number) => void): void {
    this._pending = Math.min(this._pending + dt, this.step * this.maxSteps);
    // A little tolerance: 0.05 + 0.05 is less than 0.1 in floating point.
    while (this._pending >= this.step - 1e-9) {
      update(this.step);
      this._pending -= this.step;
    }
  }
}
