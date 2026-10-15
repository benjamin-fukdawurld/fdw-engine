import { Camera } from '@fdw/engine-core';
import { fakeBackend, surface } from '@fdw/engine-core/testing';
import { FakeInputSource, Input } from '@fdw/engine-input';
import { Scene } from '@fdw/engine-scene';
import { describe, expect, it } from 'vitest';
import { buildArena } from './arena';
import { fpsControls } from './controls';
import { createFpsScene } from './fps';
import { FpsGame } from './game';

const step = 1 / 60;

// A game in a scene, driven by a fake source: the game map enabled.
const setup = () => {
  const scene = new Scene();
  const arena = buildArena(scene);
  const source = new FakeInputSource();
  const input = new Input(source);
  const { game: actions } = fpsControls(input);
  actions.enabled = true;
  input.update();
  const game = new FpsGame(scene, arena, new Camera(), actions);
  // A frame: the input, then the systems in the order of the scheduler.
  const frame = (dt = step) => {
    input.update();
    game.drones.steer(dt, game.player.position);
    game.strikes(dt);
    game.drones.fade(dt);
    game.waves(dt);
    game.player.update(dt);
    game.drones.draw(1, game.player.position);
    game.shoot();
    game.weapon.update(dt, game.player.walked);
  };
  return { scene, arena, source, input, actions, game, frame };
};

describe('fpsControls', () => {
  it('starts in the menu; the game walks but does not fly', () => {
    const input = new Input(new FakeInputSource());
    const { game, menu } = fpsControls(input);
    expect(game.enabled).toBe(false);
    expect(menu.enabled).toBe(true);
    expect(game.toJSON()['lift']).toEqual([]);
    expect(game.toJSON()['fire']).toContain('gamepad:rightTrigger');
  });
});

describe('FpsPlayer', () => {
  it('walks, is stopped by the walls, and stays in the arena', () => {
    const { source, game, frame } = setup();
    const { player } = game;
    expect(player.position).toMatchObject({ x: 0, y: 1.6, z: 8 });
    // Backwards, towards the south wall, for long enough to reach it.
    source.keyDown('KeyS');
    for (let i = 0; i < 300; i++) {
      frame();
    }
    expect(player.position.z).toBeCloseTo(20 - player.radius, 3);
    expect(player.walked).toBeGreaterThan(10);
  });

  it('jumps, then lands', () => {
    const { source, game, frame } = setup();
    source.keyDown('Space');
    frame();
    source.keyUp('Space');
    frame();
    expect(game.player.grounded).toBe(false);
    expect(game.player.position.y).toBeGreaterThan(1.6);
    for (let i = 0; i < 120; i++) {
      frame();
    }
    expect(game.player.grounded).toBe(true);
    expect(game.player.position.y).toBe(1.6);
  });
});

describe('FpsGame', () => {
  it('shoots down the drone ahead in three hits, and scores', () => {
    const { source, game, frame } = setup();
    expect(game.wave).toBe(1);
    expect(game.drones.flying).toBe(3);
    // The trigger held: a shot each time the weapon is ready.
    source.keyDown('KeyF');
    let frames = 0;
    while (game.hits < 3 && frames++ < 100) {
      frame(0.13);
    }
    expect(game.hits).toBe(3);
    expect(game.shots).toBe(3);
    expect(game.score).toBe(100);
    expect(game.drones.flying).toBe(2);
    // The drone falls, then is removed.
    source.keyUp('KeyF');
    frame(0.6);
    expect(game.drones.Drone.entities.length).toBe(2);
  });

  it('sparks on the arena, not on what the player carries', () => {
    const { source, game, frame } = setup();
    // Down at the floor: no drone there.
    game.player.fly.pitch = -1.2;
    source.keyDown('KeyF');
    frame();
    expect(game.shots).toBe(1);
    expect(game.hits).toBe(0);
  });

  it('is struck by the drones it lets come, until the game is over', () => {
    const { game, frame } = setup();
    let frames = 0;
    while (game.player.health === 100 && frames++ < 1000) {
      frame();
    }
    // The drones flew 13 m and more, then struck.
    expect(frames).toBeGreaterThan(200);
    expect(game.hurt).toBeGreaterThan(0);
    while (game.state === 'playing' && frames++ < 10000) {
      frame();
    }
    expect(game.state).toBe('over');
    expect(game.player.health).toBe(0);
    game.reset();
    expect(game).toMatchObject({ state: 'playing', wave: 1, score: 0 });
    expect(game.player.health).toBe(100);
  });

  it('sends a bigger wave once one is down', () => {
    const { game, frame } = setup();
    game.drones.clear();
    frame(1);
    expect(game.wave).toBe(1);
    frame(1.1);
    expect(game.wave).toBe(2);
    expect(game.drones.flying).toBe(5);
  });
});

describe('createFpsScene', () => {
  it('opens on the menu, plays, shoots, pauses', () => {
    const { backend } = fakeBackend();
    const source = new FakeInputSource();
    let info = '';
    const scene = createFpsScene(backend, surface, {
      input: source,
      info: (text) => (info = text),
    });
    let time = 0;
    const frame = () => scene.frame((time += step));
    frame();
    expect(info).toContain('[Play]');
    expect(info).toContain('wave 1 · 3 drones · health 100');
    // Enter: the game, the pointer locked.
    source.keyDown('Enter');
    frame();
    source.keyUp('Enter');
    frame();
    expect(info).toContain('Esc or P: menu');
    expect(source.pointerLocked).toBe(true);
    source.keyDown('KeyF');
    frame();
    source.keyUp('KeyF');
    frame();
    expect(info).toContain('hits 1/1');
    // P: the menu again, the game resumed from there.
    source.keyDown('KeyP');
    frame();
    source.keyUp('KeyP');
    frame();
    expect(info).toContain('[Resume]');
    expect(source.pointerLocked).toBe(false);
    scene.destroy();
  });
});
