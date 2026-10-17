---
title: L'audio
description: L'API audio abstraite, ses bus, ses voix et son auditeur, les effets et la musique, sa liaison à la scène, WebAudio et miniaudio, et comment brancher un autre moteur audio.
sidebar:
  order: 14
---

Le moteur ne mixe pas le son lui-même : il définit ce qu'il demande à un
moteur audio, et joue sur celui de la plateforme.

- `@fdw/engine-audio` : l'**API abstraite** (moteur, bus, clips, flux,
  voix, auditeur), les **effets** (`SoundEffect`) et la **musique**
  (`MusicPlayer`), la **liaison à la scène** (`SceneAudio`), les
  **chargeurs** du système de ressources, et un `FakeAudioEngine` pour les
  tests. Il ne dépend d'aucune bibliothèque audio.
- `@fdw/engine-audio-web` : l'API sur **WebAudio**, dans une page.
- `@fdw/engine-audio-native` : l'API sur **miniaudio**, dans Node (les démos
  natives), par l'addon de `@fdw/engine-native`.

Le tutoriel [L'audio](/fdw-engine/fr/tutorials/audio/) les assemble.

## L'API

| Interface       | Ce que c'est                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `AudioEngine`   | Une implémentation : décode, mixe, joue ; ses bus, son auditeur, ses voix, `update()`                    |
| `AudioBus`      | Un mix à un volume : `volume`, `muted`, `stopAll(fadeOut)` ; le bus maître est la sortie                 |
| `AudioClip`     | Des échantillons décodés : `duration`, `sampleRate`, `channels`, `frames`, `byteLength`, `dispose()`     |
| `AudioStream`   | Des octets encodés, décodés pendant la lecture : `duration` (NaN si inconnue), `byteLength`, `dispose()` |
| `Voice`         | Une source qui joue : `state`, `time`, `volume`, `pitch`, `pan`, `loop`, fondus, `stop`, `ended`         |
| `AudioListener` | D'où le son est entendu : `setPose(position, forward, up)`, `setMatrix(worldMatrix)`                     |

Les volumes sont des gains linéaires (1 inchangé, 0,5 environ 6 dB plus
bas) ; les temps sont en secondes ; les positions en mètres, y vers le
haut, comme dans la scène.

### Le moteur

| Membre                                | Usage                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `createBus(name, { parent, volume })` | Un bus, sous le maître sauf indication ; `bus(name)` le retrouve              |
| `createClip(channels, sampleRate)`    | Un clip d'échantillons, un `Float32Array` par canal : un son fait par le code |
| `decodeClip(bytes, { signal })`       | Un clip d'un fichier WAV, Ogg Vorbis, MP3 ou FLAC                             |
| `createStream(bytes, { signal })`     | Un flux d'un tel fichier, gardé encodé                                        |
| `play(source, options)`               | Une nouvelle voix                                                             |
| `voices`                              | Les voix vivantes : en lecture, en pause ou en fondu de sortie                |
| `state`, `resume()`, `suspend()`      | `running`, `suspended` (une page avant un geste) ou `closed`                  |
| `time`, `sampleRate`                  | L'horloge du mix                                                              |
| `update()`                            | À chaque frame : les voix finies sont libérées, leur `ended` résolu           |
| `destroy()`                           | Arrête tout, libère le moteur                                                 |

### Jouer

```ts
const voice = engine.play(source, {
  bus: sfx, // le maître par défaut
  volume: 1,
  pitch: 1, // la vitesse de lecture : 2, une octave plus haut, deux fois plus vite
  pan: 0, // -1 à gauche, 1 à droite, pour une voix non spatiale
  loop: false,
  offset: 0, // commence à, en secondes
  fadeIn: 0, // monte depuis le silence en, secondes
  paused: false, // resume() la démarre
  spatial: {
    // seulement pour une voix placée dans le monde
    position: { x: 0, y: 0, z: 0 },
    refDistance: 1,
    maxDistance: 100,
    rolloff: 1,
    distanceModel: 'inverse', // 'linear', 'exponential'
  },
});
```

Une voix a deux gains, multipliés : son `volume`, appliqué tout de suite,
et son **fondu**, déplacé dans le temps par `fadeTo(gain, seconds)`,
`fadeIn` et `stop(fadeOut)`. Une voix arrêtée ou à sa fin a disparu :
rejouer la source crée une nouvelle voix.

**Le panoramique** : une source mono va dans les deux oreilles à plein
gain ; `pan` déplace un côté dans l'autre — à -1, tout est dans l'oreille
gauche. Une source stéréo garde ses côtés à 0.

**La distance**, pour une voix spatiale à `d` mètres, `r` sa
`refDistance`, `f` son `rolloff`, `m` sa `maxDistance` (les modèles de
WebAudio) :

| Modèle        | Gain                                   |
| ------------- | -------------------------------------- |
| `inverse`     | `r / (r + f (max(d, r) - r))`          |
| `linear`      | `1 - f (clamp(d, r, m) - r) / (m - r)` |
| `exponential` | `(max(d, r) / r)^-f`                   |

Il n'y a pas d'effet Doppler.

### Les effets et la musique

`SoundEffect` joue souvent un son court : des variantes (une tirée par
lecture, jamais la même deux fois de suite), `volumeVariation` et
`pitchVariation` (`± fraction`), `maxVoices` (la plus ancienne s'arrête pour
la plus récente, en fondu de `stealFade` secondes), `cooldown` ;
`play(overrides)`, `playAt(position)`, `voices`, `stop(fadeOut)`. Une
fonction `random` le rend déterministe.

`MusicPlayer` joue un morceau à la fois, en boucle par défaut, en fondu
enchaîné de l'un au suivant (`crossfade` secondes) ; `track`, `voice`,
`play(track, { crossfade, volume, loop, offset, restart })`,
`stop(fadeOut)`, `pause()`, `resume()`.

### La scène

`SceneAudio(scene, engine)` :

- `listener` : le nœud que suit l'auditeur (sa matrice monde, regardant
  vers -z) ;
- `play(node, source, options)` : une voix spatiale sur le nœud, qui le
  suit ; `attach(node, voice)` pour une voix jouée ailleurs ;
  `voicesOf(node)` ;
- `update()` : l'auditeur et les voix là où sont leurs nœuds, puis
  `engine.update()` ; `install(scheduler)` en fait le système `audio` de la
  phase `render` ;
- les voix d'un nœud sont un composant de son entité (`audio emitter`) :
  elles s'arrêtent, en fondu de `removeFade` secondes, quand le nœud est
  retiré.

### Les ressources

`installAudio(store, engine)` enregistre deux chargeurs et
l'`AudioEngineService` :

| Type              | Valeur        | Chargeur                  |
| ----------------- | ------------- | ------------------------- |
| `AudioClipType`   | `AudioClip`   | `decodeClip` des octets   |
| `AudioStreamType` | `AudioStream` | `createStream` des octets |

Les deux reconnaissent `.wav`, `.ogg`, `.oga`, `.mp3`, `.flac`, leurs types
MIME, et les premiers octets des fichiers (`sniffAudioFormat`). Leur
taille, pour le budget du cache, est leur `byteLength` ; une entrée libérée
libère son son. `encodeWav(channels, sampleRate)` écrit un fichier WAV
depuis des échantillons.

## WebAudio

```ts
import { unlockAudio, WebAudioEngine } from '@fdw/engine-audio-web';

const engine = new WebAudioEngine({ panningModel: 'HRTF' });
unlockAudio(engine); // relance au premier geste sur la fenêtre
```

- Les clips sont des `AudioBuffer`, rééchantillonnés à la fréquence du
  contexte par `decodeAudioData` ; les bus sont des `GainNode` ; une voix
  est une source, un gain, un gain de fondu, et un `StereoPannerNode` ou un
  `PannerNode`.
- Les **flux** sont des éléments média qui lisent les octets depuis une URL
  d'objet (`MediaElementAudioSourceNode`) : le navigateur les décode
  pendant la lecture. La durée vient des métadonnées du fichier.
- **Le geste** : une page ne peut pas démarrer son son toute seule. Le
  contexte démarre suspendu ; `resume()` depuis un clic ou une touche le
  démarre, et `unlockAudio(engine, target)` le fait au premier. Les voix
  jouées avant sont gardées : elles sont entendues à partir de là.
- `panningModel` : `equalpower` par défaut ; `HRTF` place mieux les sons au
  casque, pour plus de calcul.
- `context` : un `OfflineAudioContext` rend le mix dans un buffer, plus vite
  que le temps réel (les tests). Sans éléments média, les flux y sont
  décodés tout de suite.

## miniaudio

```ts
import { NativeAudioEngine } from '@fdw/engine-audio-native';

const engine = new NativeAudioEngine();
```

- [miniaudio](https://miniaud.io) (0.11, domaine public ou MIT-0) est
  compilé dans l'addon de `@fdw/engine-native`, avec ses décodeurs (WAV,
  FLAC, MP3) et `stb_vorbis` (Ogg Vorbis). Il mixe sur son propre thread, sur
  le périphérique par défaut : PulseAudio ou ALSA sous Linux, CoreAudio sous
  macOS, WASAPI sous Windows — et un périphérique nul quand il n'y en a
  pas, pour que le code tourne de même sur un serveur.
- Les **clips** sont décodés sur le pool de threads de libuv, jamais sur le
  thread JavaScript, à la fréquence du fichier ; une voix rééchantillonne.
  Un clip est partagé par ses voix, et libéré quand la dernière a fini.
- Un **flux** garde les octets du fichier en mémoire native ; chaque voix a
  son propre décodeur, exécuté par le thread de mixage.
- `offline: true` : pas de périphérique ; `render(out)` mixe les frames
  suivantes dans un tableau (les tests, ou un son rendu dans un fichier).
- La bibliothèque a une API C (`native/include/fdw/audio.h`), utilisable
  par un autre hôte.

## Les différences entre les moteurs

Ils suivent le même contrat, vérifié par les mêmes sortes de tests (les
voix finissent, bouclent, se mettent en pause, en fondu ; les bus ; les
modèles de distance ; les décodeurs). Ce qui diffère :

- **Le panoramique entre les oreilles** d'une voix spatiale : à puissance
  égale dans WebAudio, le spatialiseur de miniaudio en natif (il garde un
  peu du son dans l'oreille éloignée). L'atténuation par la distance est la
  même.
- **Le démarrage** : immédiat en natif ; après un geste dans une page.
- **Le temps d'une voix** avance en natif de quelques millisecondes : le
  mixeur lit ses sources par blocs.

## Brancher un autre moteur

Implémentez `AudioEngine` (FMOD, Wwise, OpenAL, un mixeur à vous), avec ses
`AudioBus`, `AudioClip`, `AudioStream` et `Voice`. `resolvePlay(options)`
donne les valeurs par défaut de `play`, `AudioListenerPose` garde la pose
de l'auditeur et vous la transmet. `SoundEffect`, `MusicPlayer`,
`SceneAudio` et les chargeurs sont écrits contre l'API : ils fonctionnent
tels quels.

`FakeAudioEngine` est un tel moteur, sans son : `advance(seconds)` avance
son horloge et ses voix, qui gardent ce qu'on leur a dit (positions,
fondus, volumes). Les tests d'un jeu l'utilisent.
