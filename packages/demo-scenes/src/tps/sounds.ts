import {
  MusicPlayer,
  SceneAudio,
  SoundEffect,
  type AudioClip,
  type AudioEngine,
} from '@fdw/engine-audio';
import type { Node, Scene } from '@fdw/engine-scene';
import {
  chimeSound,
  clangSound,
  footstepSound,
  forestAmbience,
  gruntSound,
  hurtSound,
  musicLoop,
  slashSound,
  swingSound,
} from '../audio/synth';
import type { EnemyEvents, EnemyKind } from './enemies';
import type { HeroEvents } from './hero';

const effectRate = 44100;
const musicRate = 22050;

/**
 * The sounds of the TPS, all made by code: the steps of the hero and of
 * the orcs, the blade, the blows, the parries, the grunts and the cry of
 * the demon, where they happen; the forest under the menu and between the
 * waves, a music for the fights. The listener is the camera.
 */
export class TpsSounds {
  readonly audio: SceneAudio;
  readonly music: MusicPlayer;
  /** What the hero tells them. */
  readonly hero: HeroEvents;
  /** What the enemies tell them. */
  readonly enemies: EnemyEvents;
  private readonly _clips: AudioClip[] = [];
  private readonly _forest: AudioClip;
  private readonly _fight: AudioClip;
  private _fighting: boolean | undefined;

  constructor(
    scene: Scene,
    readonly engine: AudioEngine,
    listener: Node,
  ) {
    this.audio = new SceneAudio(scene, engine);
    this.audio.listener = listener;
    const sfx = engine.bus('sfx') ?? engine.createBus('sfx');
    const music = engine.bus('music') ?? engine.createBus('music');
    music.volume = 0.55;
    const clip = (samples: Float32Array, rate = effectRate) => {
      const made = engine.createClip([samples], rate);
      this._clips.push(made);
      return made;
    };
    const effect = (
      sources: AudioClip[],
      options: ConstructorParameters<typeof SoundEffect>[2] = {},
    ) => new SoundEffect(engine, sources, { bus: sfx, ...options });
    const steps = effect(
      [1, 2, 3, 4].map((seed) => clip(footstepSound(effectRate, seed * 7))),
      { volume: 0.35, pitchVariation: 0.12, maxVoices: 4 },
    );
    const swing = effect([clip(swingSound(effectRate))], {
      volume: 0.5,
      pitchVariation: 0.1,
    });
    const heavySwing = effect([clip(swingSound(effectRate, 0.5))], {
      volume: 0.6,
      pitch: 0.8,
    });
    const slash = effect([clip(slashSound(effectRate))], {
      volume: 0.7,
      pitchVariation: 0.15,
      spatial: { refDistance: 3 },
    });
    const clang = effect([clip(clangSound(effectRate))], {
      volume: 0.5,
      pitchVariation: 0.05,
      cooldown: 0.1,
    });
    const hurt = effect([clip(hurtSound(effectRate))], {
      volume: 0.8,
      cooldown: 0.2,
    });
    const grunts = effect(
      [1, 2, 3].map((seed) => clip(gruntSound(effectRate, 1, 0.4, seed * 13))),
      {
        volume: 0.6,
        pitchVariation: 0.15,
        maxVoices: 3,
        spatial: { refDistance: 4 },
      },
    );
    const roar = effect([clip(gruntSound(effectRate, 0.55, 1.4, 5))], {
      volume: 0.9,
      spatial: { refDistance: 8 },
    });
    const chime = effect([clip(chimeSound(effectRate, [69, 76, 81]))], {
      volume: 0.5,
    });
    const dirge = effect([clip(chimeSound(effectRate, [64, 60, 57]))], {
      volume: 0.5,
    });
    const enemySteps = effect(
      [1, 2].map((seed) => clip(footstepSound(effectRate, seed * 11 + 50))),
      {
        volume: 0.5,
        pitch: 0.7,
        pitchVariation: 0.1,
        maxVoices: 6,
        spatial: { refDistance: 3 },
      },
    );
    this.hero = {
      step: () => steps.play(),
      swing: (heavy) => (heavy ? heavySwing : swing).play(),
      jump: () => steps.play({ volume: 0.25 }),
      land: () => steps.play({ volume: 0.5, pitch: 0.8 }),
      roll: () => steps.play({ volume: 0.4, pitch: 0.7 }),
      hurt: () => hurt.play(),
      blocked: () => clang.play(),
      death: () => dirge.play(),
    };
    const isDemon = (kind: EnemyKind) => kind.name === 'demon';
    this.enemies = {
      spawned: (at, kind) => (isDemon(kind) ? roar : grunts).playAt(at),
      swing: (at, kind) =>
        (isDemon(kind) ? roar : grunts).playAt(at, { volume: 0.4 }),
      hurt: (at) => slash.playAt(at),
      death: (at, kind) => {
        slash.playAt(at);
        (isDemon(kind) ? roar : grunts).playAt(at, { pitch: 0.7 });
      },
      step: (at) => enemySteps.playAt(at),
    };
    this.wave = () => chime.play();
    this._forest = clip(forestAmbience(musicRate), musicRate);
    this._fight = clip(
      musicLoop(musicRate, {
        tempo: 120,
        roots: [45, 43, 41, 40],
        arpeggio: [0, 2, 1, 2, 0, 3, 2, 1],
      }),
      musicRate,
    );
    this.music = new MusicPlayer(engine, { bus: music, crossfade: 2 });
  }

  /** A wave comes. */
  readonly wave: () => void;

  /** The forest when calm, the music when enemies are around. */
  fight(on: boolean): void {
    if (on === this._fighting) return;
    this._fighting = on;
    this.music.play(on ? this._fight : this._forest);
  }

  /** At each frame, after the nodes moved. */
  update(): void {
    this.audio.update();
  }

  destroy(): void {
    this.audio.destroy();
    this.engine.bus('sfx')?.stopAll();
    this.engine.bus('music')?.stopAll();
    this.engine.update();
    this._clips.forEach((clip) => clip.dispose());
  }
}
