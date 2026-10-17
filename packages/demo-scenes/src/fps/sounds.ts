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
  explosionSound,
  hitSound,
  humSound,
  hurtSound,
  musicLoop,
  shotSound,
} from '../audio/synth';

/** What the game tells its sounds. */
export interface FpsSoundEvents {
  shot(): void;
  hit(): void;
  /** A drone appeared at its node. */
  spawned(drone: Node): void;
  /** A drone shot down. */
  down(drone: Node): void;
  hurt(): void;
  wave(wave: number): void;
}

// The rates of the sounds made by code: enough for effects, less for the
// music (generated at the start).
const effectRate = 44100;
const musicRate = 22050;

/**
 * The sounds of the FPS, all made by code: the shots and the hits, a hum
 * for each drone where it flies, its explosion where it falls, the blows,
 * the waves; a calm music under the menu crossfaded to a tenser one in the
 * game. The listener is the eye of the player.
 */
export class FpsSounds implements FpsSoundEvents {
  readonly audio: SceneAudio;
  readonly music: MusicPlayer;
  private readonly _clips: AudioClip[] = [];
  private readonly _shot: SoundEffect;
  private readonly _hit: SoundEffect;
  private readonly _explosion: SoundEffect;
  private readonly _hurt: SoundEffect;
  private readonly _chime: SoundEffect;
  private readonly _hum: AudioClip;
  private readonly _calm: AudioClip;
  private readonly _fight: AudioClip;

  constructor(
    scene: Scene,
    readonly engine: AudioEngine,
    eye: Node,
  ) {
    this.audio = new SceneAudio(scene, engine);
    this.audio.listener = eye;
    const sfx = engine.bus('sfx') ?? engine.createBus('sfx');
    const music = engine.bus('music') ?? engine.createBus('music');
    music.volume = 0.5;
    const clip = (samples: Float32Array, rate = effectRate) => {
      const made = engine.createClip([samples], rate);
      this._clips.push(made);
      return made;
    };
    this._shot = new SoundEffect(engine, clip(shotSound(effectRate)), {
      bus: sfx,
      volume: 0.6,
      pitchVariation: 0.06,
      maxVoices: 6,
    });
    this._hit = new SoundEffect(engine, clip(hitSound(effectRate)), {
      bus: sfx,
      volume: 0.5,
      pitchVariation: 0.1,
    });
    this._explosion = new SoundEffect(
      engine,
      clip(explosionSound(effectRate)),
      {
        bus: sfx,
        pitchVariation: 0.15,
        spatial: { refDistance: 3 },
      },
    );
    this._hurt = new SoundEffect(engine, clip(hurtSound(effectRate)), {
      bus: sfx,
      volume: 0.8,
      cooldown: 0.25,
    });
    this._chime = new SoundEffect(engine, clip(chimeSound(effectRate)), {
      bus: sfx,
      volume: 0.5,
    });
    this._hum = clip(humSound(effectRate));
    this._calm = clip(
      musicLoop(musicRate, { tempo: 80, roots: [45, 41, 43, 40] }),
      musicRate,
    );
    this._fight = clip(
      musicLoop(musicRate, {
        tempo: 132,
        roots: [45, 45, 46, 44],
        arpeggio: [0, 2, 1, 3, 0, 2, 4, 3],
      }),
      musicRate,
    );
    this.music = new MusicPlayer(engine, { bus: music, crossfade: 1.5 });
  }

  /** The calm music under the menu, the tense one in the game. */
  menu(open: boolean): void {
    this.music.play(open ? this._calm : this._fight);
  }

  shot(): void {
    this._shot.play();
  }

  hit(): void {
    this._hit.play();
  }

  spawned(drone: Node): void {
    // Each its own pitch: a swarm, not a choir.
    this.audio.play(drone, this._hum, {
      bus: this.engine.bus('sfx'),
      loop: true,
      volume: 0.5,
      pitch: 0.9 + 0.2 * Math.random(),
      fadeIn: 0.5,
      spatial: { refDistance: 2, rolloff: 1.2 },
    });
  }

  down(drone: Node): void {
    for (const voice of this.audio.voicesOf(drone)) {
      voice.stop(0.3);
    }
    this._explosion.playAt(drone.worldPosition);
  }

  hurt(): void {
    this._hurt.play();
  }

  wave(): void {
    this._chime.play();
  }

  /** At each frame, after the nodes moved. */
  update(): void {
    this.audio.update();
  }

  destroy(): void {
    this.audio.destroy();
    // The music fading out too.
    this.engine.bus('sfx')?.stopAll();
    this.engine.bus('music')?.stopAll();
    this.engine.update();
    this._clips.forEach((clip) => clip.dispose());
  }
}
