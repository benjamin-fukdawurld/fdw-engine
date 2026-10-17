import type { Node, Phase, Scene, Scheduler } from '@fdw/engine-scene';
import type { AudioEngine, AudioSource, PlayOptions, Voice } from './api';

export interface SceneAudioInstallOptions {
  /** The name of the system. Default `audio`. */
  readonly name?: string;
  /** Default `render`: after everything that moves the nodes. */
  readonly phase?: Phase;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export interface SceneAudioOptions {
  /** The fade out of the voices of a node removed, in seconds. Default 0.05. */
  readonly removeFade?: number;
}

/**
 * The audio of a scene: the listener follows a node (the camera), the
 * voices played at a node follow it, as a component of its entity — they
 * stop with it.
 *
 * ```ts
 * const audio = new SceneAudio(scene, engine);
 * audio.listener = cameraNode;
 * audio.play(drone, hum, { loop: true, bus: sfx });
 * audio.install(scheduler); // or audio.update() at each frame
 * ```
 */
export class SceneAudio {
  /** The component of the entities playing voices: their voices. */
  readonly Emitter;
  /** The node the listener follows; none: it stays where it is. */
  listener: Node | undefined;
  removeFade: number;

  private readonly _query;
  private readonly _unsubscribe: () => void;
  private readonly _done: number[] = [];

  constructor(
    readonly scene: Scene,
    readonly engine: AudioEngine,
    options: SceneAudioOptions = {},
  ) {
    this.removeFade = options.removeFade ?? 0.05;
    this.Emitter = scene.world.defineComponent('audio emitter', {
      voices: 'ref',
    });
    this._query = scene.world.query(this.Emitter);
    // A node removed stops its voices.
    this._unsubscribe = scene.world.onRemoved(this.Emitter, (entity) => {
      const voices = this.Emitter.voices[entity] as Voice[] | undefined;
      voices?.forEach((voice) => voice.stop(this.removeFade));
    });
  }

  /**
   * Plays `source` at the node, spatial: the voice follows the node until it
   * ends, or the node is removed.
   */
  play(node: Node, source: AudioSource, options: PlayOptions = {}): Voice {
    const m = node.worldMatrix;
    const voice = this.engine.play(source, {
      ...options,
      spatial: {
        ...options.spatial,
        position: { x: m[12], y: m[13], z: m[14] },
      },
    });
    this.attach(node, voice);
    return voice;
  }

  /** Makes a spatial voice follow a node. */
  attach(node: Node, voice: Voice): void {
    if (!voice.spatial) {
      throw new Error('Only a spatial voice can follow a node');
    }
    if (!this.Emitter.has(node.entity)) {
      node.attach(this.Emitter, { voices: [] });
    }
    (this.Emitter.voices[node.entity] as Voice[]).push(voice);
  }

  /** The voices following a node. */
  voicesOf(node: Node): readonly Voice[] {
    return this.Emitter.has(node.entity)
      ? (this.Emitter.voices[node.entity] as Voice[])
      : [];
  }

  /**
   * At each frame, after the nodes moved: the listener and the voices at
   * their nodes, then `engine.update()`.
   */
  update(): void {
    if (this.listener?.alive) {
      this.engine.listener.setMatrix(this.listener.worldMatrix);
    }
    const entities = this._query.entities;
    const done = this._done;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const voices = this.Emitter.voices[entity] as Voice[];
      const m = this.scene.worldMatrix(entity);
      for (let k = voices.length - 1; k >= 0; k--) {
        const voice = voices[k];
        if (voice.state === 'stopped') {
          voices.splice(k, 1);
        } else {
          voice.setPosition(m[12], m[13], m[14]);
        }
      }
      if (voices.length === 0) {
        done.push(entity);
      }
    }
    // Out of the loop: a component removed moves the entities of the query.
    for (const entity of done) {
      this.scene.world.remove(entity, this.Emitter);
    }
    done.length = 0;
    this.engine.update();
  }

  /** The system of the audio: `audio`, in the `render` phase by default. */
  install(scheduler: Scheduler, options: SceneAudioInstallOptions = {}): void {
    scheduler.add(options.name ?? 'audio', () => this.update(), {
      phase: options.phase ?? 'render',
      before: options.before,
      after: options.after,
    });
  }

  /** Stops the voices of the nodes, and stops listening to the scene. */
  destroy(): void {
    for (const entity of [...this._query.entities]) {
      this.scene.world.remove(entity, this.Emitter);
    }
    this._unsubscribe();
  }
}
