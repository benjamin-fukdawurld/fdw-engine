/**
 * A loop at a fixed step: the logic advances by steps of the same length
 * (1/60 s by default), as many as the time of the frame holds, whatever
 * the rate of the screen. The same inputs then give the same game, at 30
 * or 144 frames per second.
 */
export class FixedStep {
  // The time of the frames not consumed by a step yet.
  private _pending = 0;

  constructor(
    /** The length of a step, in seconds. */
    public step = 1 / 60,
    // At most this many steps per frame: after a long pause, the game
    // slows down instead of running hundreds of steps at once.
    public maxSteps = 5,
  ) {}

  /**
   * How far the time is between the last step and the next, from 0 to 1:
   * the weight of the current state against the previous one, to draw
   * between the two.
   */
  get alpha(): number {
    return Math.min(Math.max(this._pending / this.step, 0), 1);
  }

  /** Runs the steps a frame of `dt` seconds holds; returns their number. */
  advance(dt: number, update: (step: number) => void): number {
    this._pending = Math.min(this._pending + dt, this.step * this.maxSteps);
    let steps = 0;
    // A little tolerance: 0.05 + 0.05 is less than 0.1 in floating point.
    while (this._pending >= this.step - 1e-9) {
      update(this.step);
      this._pending -= this.step;
      steps++;
    }
    return steps;
  }

  /** Forgets the time pending: the next step waits for a full step. */
  reset(): void {
    this._pending = 0;
  }
}
