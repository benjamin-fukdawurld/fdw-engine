import { PointLight, SpotLight } from '@fdw/engine-core';
import type { Node } from '@fdw/engine-scene';

/**
 * The flashlight of the character: a spot casting shadows, held in front of
 * it and tilted down, and a faint glow around the character, so that it
 * stays visible out of the beam. Both are children of the node of the
 * character: they turn with it.
 */
export class Flashlight {
  readonly beam: SpotLight;
  readonly glow: PointLight;
  readonly node: Node;

  constructor(character: Node) {
    this.beam = new SpotLight({
      // No ambient: it does not fade with the distance, and would light
      // everything the beam might reach, up to where the culling stops.
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: { x: 1.6, y: 1.5, z: 1.3 },
      specular: { x: 0.6, y: 0.55, z: 0.5 },
      innerCutoff: 16,
      outerCutoff: 28,
      quadraticAttenuation: 0.04,
      castShadow: true,
    });
    // In the hand, in front of the body; tilted 20° down. Within the radius
    // of the character: against a wall, the light must not be in it (the
    // wall would cast no shadow, and the beam would go through).
    this.node = character
      .add({
        name: 'flashlight',
        position: { x: 0.15, y: 0.9, z: -0.2 },
        rotation: { x: Math.sin(-0.175), y: 0, z: 0, w: Math.cos(-0.175) },
      })
      .setLight(this.beam);
    this.glow = new PointLight({
      ambient: { x: 0, y: 0, z: 0 },
      diffuse: { x: 0.4, y: 0.36, z: 0.32 },
      specular: { x: 0, y: 0, z: 0 },
      quadraticAttenuation: 0.8,
    });
    character.add({ name: 'glow', position: { y: 1.6 } }).setLight(this.glow);
  }

  /** Switches the flashlight on or off (the glow stays). */
  set on(on: boolean) {
    this.node.visible = on;
  }

  get on(): boolean {
    return this.node.visible;
  }
}
