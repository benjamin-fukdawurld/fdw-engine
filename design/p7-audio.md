# P7 : l'audio

Le design de la phase P7 de la [roadmap](roadmap.md#p7-audio) : une API audio abstraite, deux implémentations (WebAudio dans le navigateur, miniaudio en natif), les effets courts et la musique, la spatialisation liée à la scène, et le chargement des sons par le système de ressources (P5).

Contraintes : pas de grosse dépendance en dur (§1 de la roadmap) : le cœur ne dépend d'aucune bibliothèque audio ; le même code de jeu sur le web et en natif (Node) ; jamais de décodage sur le thread JavaScript en natif ; des tests sans carte son.

## 1. Aujourd'hui

| Ce qui existe                                                                   | Ce qui manque                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Le système de ressources (P5) : chargeurs par type, services, sources montées   | Des types de sons, leurs chargeurs, le moteur qui les décode     |
| L'addon natif (`engine-native`) : SDL3 pour les fenêtres, stb_image sur le pool | Une sortie audio, des décodeurs (Vorbis, MP3…), un mixeur        |
| L'ordonnanceur (P4) : les phases, les nœuds dessinés entre deux pas             | Un auditeur qui suit la caméra, des sons qui suivent leurs nœuds |
| La démo FPS : des tirs, des drones, des vagues                                  | Des sons dans les démos                                          |

## 2. Les options

### 2.1 Le moteur natif

| Candidat                   | Intérêt                                                                                                                                                                                                                              | Coût                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A. SDL3 audio              | Déjà lié ; `SDL_AudioStream` mixe les flux liés à un périphérique, avec gain et rééchantillonnage                                                                                                                                    | Pas de décodeur hors WAV, pas de spatialisation ni de bus, pas de fondus : un mixeur à écrire en C               |
| B. Un mixeur en TypeScript | Le même code partout                                                                                                                                                                                                                 | Le mixage sur le thread JavaScript : un ramasse-miettes qui passe, un trou dans le son ; des décodeurs à trouver |
| **C. miniaudio**           | **Un fichier C (domaine public / MIT-0) : périphériques de toutes les plateformes, décodeurs WAV, FLAC, MP3 (et Vorbis par stb_vorbis), un graphe de mixage, des groupes, la spatialisation, les fondus, un mode sans périphérique** | 4 Mo de source compilés une fois ; son modèle de spatialisation n'est pas celui de WebAudio                      |

**Choix : C**, téléchargé par CMake (`FetchContent`, étiquette 0.11.25) comme SDL3, sans son propre projet CMake (`SOURCE_SUBDIR none`), lié statiquement dans `fdw_native.node`. Sans gestionnaire de ressources (`MA_NO_RESOURCE_MANAGER`) : les sons arrivent en mémoire par le système de ressources, pas par des fichiers. SDL3 reste pour les fenêtres et les entrées.

### 2.2 Les sons : décodés ou en flux

| Option                                                               | Intérêt                                                                                                                                    | Coût                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| A. Tout décodé au chargement                                         | Une seule sorte de son                                                                                                                     | Une minute de musique stéréo : 20 Mo d'échantillons       |
| B. Tout en flux                                                      | Peu de mémoire                                                                                                                             | Un tir décodé à chaque lecture ; une latence au démarrage |
| **C. Deux sources : `AudioClip` (décodé) et `AudioStream` (encodé)** | **Les effets démarrent tout de suite et se partagent entre des dizaines de voix ; une musique tient en quelques centaines de kilo-octets** | Deux types de ressources, deux chargeurs                  |

**Choix : C.** En natif, un clip est décodé sur le pool de libuv, partagé par ses voix (compté par références, libéré après la dernière) ; un flux garde les octets, chaque voix a son décodeur, lu par le thread de mixage. Dans le navigateur, un clip est un `AudioBuffer` (`decodeAudioData`) ; un flux, un élément média qui lit une URL d'objet (`MediaElementAudioSourceNode`), décodé par le navigateur pendant la lecture.

### 2.3 L'API

| Option                                              | Intérêt                                                                   | Coût                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A. WebAudio partout (un polyfill natif)             | Une API connue                                                            | Un graphe de nœuds à émuler en natif ; trop large pour un jeu |
| **B. Des interfaces : moteur, bus, sources, voix**  | **Ce qu'un jeu demande, sur WebAudio comme sur miniaudio, FMOD ou Wwise** | Une couche de traduction par moteur                           |
| C. Des composants ECS (une source audio par entité) | Les sons comme les corps de P7b                                           | Un tir ou un clic d'interface n'a pas de nœud                 |

**Choix : B**, avec la liaison à la scène à part (`SceneAudio`, §3), comme `ScenePhysics` : `AudioEngine` → `AudioBus`, `AudioClip`, `AudioStream`, `Voice`, `AudioListener`. Une voix par appel à `play`, qui disparaît à sa fin ; `engine.update()` à chaque frame libère les voix finies et résout leur `ended` (en natif, le thread de mixage ne rappelle jamais JavaScript).

### 2.4 Le même son sur les deux moteurs

Les règles de WebAudio sont celles de l'API, miniaudio s'y aligne :

| Question                | Règle                                                                                    | En natif                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Le panoramique          | Une source mono dans les deux oreilles à plein gain ; `pan` déplace un côté dans l'autre | `ma_pan_mode_pan` (WebAudio : la même chose en loi en sinus, mêmes extrémités) |
| L'atténuation           | Les modèles de WebAudio ; seul `linear` s'arrête à `maxDistance`                         | `maxDistance` infinie pour `inverse` et `exponential`                          |
| L'effet Doppler         | Aucun                                                                                    | Facteur 0                                                                      |
| Le volume et les fondus | Deux gains multipliés : `volume` tout de suite, le fondu dans le temps                   | `ma_sound_set_volume` et le fondu de `ma_sound`                                |
| Le démarrage            | Une page attend un geste : le contexte suspendu, les voix gardées                        | Immédiat                                                                       |

Ce qui reste différent : la loi de panoramique d'une voix spatiale (puissance égale dans WebAudio, le spatialiseur de miniaudio garde un peu de son dans l'oreille éloignée) ; le temps d'une voix native, en avance d'un bloc de mixage (quelques millisecondes).

## 3. L'API

`@fdw/engine-audio` (dépend de `engine-backend` pour les types, `engine-scene` pour la liaison, `engine-resources` pour les chargeurs) :

- **Le moteur** : `createBus`, `bus`, `createClip` (des échantillons faits par le code), `decodeClip`, `createStream`, `play`, `voices`, `state`, `resume`, `suspend`, `update`, `destroy`.
- **Les options de lecture** : bus, volume, hauteur (la vitesse de lecture), panoramique, boucle, départ, fondu d'entrée, en pause, et `spatial` (position, `refDistance`, `maxDistance`, `rolloff`, modèle de distance).
- **Les voix** : `state` (`playing`, `paused`, `stopped`), `time`, `volume`, `pitch`, `pan`, `loop`, `setPosition`, `fadeTo`, `pause`, `resume`, `stop(fadeOut)`, `ended`.
- **Les bus** : `volume`, `muted`, `stopAll(fadeOut)`, sous le maître ou sous un autre.
- **`SoundEffect`** (les effets courts) : des variantes (jamais la même deux fois de suite), le volume et la hauteur tirés au hasard autour des leurs, un nombre de voix borné (la plus ancienne s'arrête en fondu pour la plus récente), un temps de recharge, `playAt(position)`.
- **`MusicPlayer`** (la musique) : un morceau à la fois, en boucle, enchaîné en fondu ; rejouer le morceau en cours ne fait rien.
- **`SceneAudio`** (la liaison) : l'auditeur suit un nœud (la caméra) ; une voix jouée sur un nœud le suit, comme composant de son entité (`audio emitter`), arrêtée quand le nœud est retiré ; le système `audio` dans la phase `render`, après tout ce qui déplace les nœuds.
- **Les ressources** : `AudioClipType`, `AudioStreamType`, `installAudio(store, engine)` (les chargeurs et l'`AudioEngineService`) ; `.wav`, `.ogg`, `.oga`, `.mp3`, `.flac`, leurs types MIME et leurs premiers octets (`sniffAudioFormat`).
- **`FakeAudioEngine`** : un moteur sans son pour les tests, avancé par `advance(seconds)`.

## 4. Les deux moteurs

- **`WebAudioEngine`** (`@fdw/engine-audio-web`) : un bus est un `GainNode` ; une voix, une source, un gain, un gain de fondu, un `StereoPannerNode` (forcé en stéréo : la règle du §2.4) ou un `PannerNode` ; une pause recrée la source à l'endroit où elle était. Un `OfflineAudioContext` rend le mix dans un buffer (les tests) ; sans éléments média, les flux y sont décodés d'un coup. `unlockAudio(engine, target)` relance le contexte au premier geste ; un élément média refusé avant le geste est relancé par `update()`.
- **`NativeAudioEngine`** (`@fdw/engine-audio-native`) : la bibliothèque `fdw_audio` (API C, `native/include/fdw/audio.h`) sur un `ma_engine`, les bus en `ma_sound_group`, une voix en `ma_sound` sur un `ma_audio_buffer_ref` (clip) ou un `ma_decoder` (flux). Les voix sont des numéros (une case et une génération) : une voix finie ne peut pas en désigner une autre. `offline: true` : sans périphérique, `render(out)` mixe dans un tableau (les tests). Sans carte son, miniaudio prend son périphérique nul.

Ce qu'il a fallu contourner :

- **`ma_audio_buffer_ref` n'a pas de fréquence** (0, « prévu pour 0.12 ») : posée à la main, sans quoi un clip de 22 kHz joue à la fréquence du moteur.
- **La durée d'un Ogg Vorbis** est inconnue du décodeur de miniaudio (stb_vorbis en mode push) : lue par `stb_vorbis_open_memory` à la création du flux.
- **Le panoramique par défaut de miniaudio** (`balance`) diffère de WebAudio : `ma_pan_mode_pan`.
- **Les sons spatialisés par défaut** : miniaudio spatialise toutes les voix ; celles qui ne le sont pas reçoivent `MA_SOUND_FLAG_NO_SPATIALIZATION`, les bus `set_spatialization_enabled(false)`.

## 5. Les démos

- **Le FPS** joue ses sons sur le moteur de son hôte (`SceneContext.audio`) : les tirs, les coups au but et les coups reçus en `SoundEffect`, un bourdonnement qui suit chaque drone, une explosion là où il tombe, un carillon à chaque vague, une musique calme sous le menu enchaînée en fondu vers une plus rapide en jeu, une entrée « Sound » au menu. Tous les sons sont **faits par le code** (`demo-scenes/src/audio/synth.ts` : bruit, sinus, enveloppes, un petit séquenceur) : rien à charger, les mêmes dans le navigateur et en natif.
- **La documentation** : le tutoriel « L'audio » charge ses sons par le système de ressources (`apps/docs/public/sounds`, en Ogg Vorbis, écrits par `tools/docs/make-sounds.mjs` depuis le même synthétiseur et ffmpeg).

## 6. Mesures

Le mixage natif (`fdw_audio_render`, sans périphérique, 48 kHz stéréo, une seconde mixée, Node 24, build Release) :

| Voix                                     | Temps pour 1 s de son | Part d'un cœur |
| ---------------------------------------- | --------------------- | -------------- |
| 64 clips, non spatiaux, rééchantillonnés | 24 ms                 | 2,4 %          |
| 64 clips spatiaux                        | 27 ms                 | 2,7 %          |
| 256 clips spatiaux                       | 106 ms                | 10,6 %         |
| 8 flux Ogg Vorbis                        | 5 ms                  | 0,5 %          |

Un jeu tient donc une centaine de voix sans y penser ; au-delà, `SoundEffect.maxVoices` borne ce qui en produit le plus. La synthèse des sons du FPS au démarrage : environ 100 ms (les deux musiques, 22 kHz).

## 7. Tests

- **`engine-audio`** (sur le faux moteur) : les valeurs par défaut de `play`, la pose d'une matrice, l'auditeur normalisé, les bus imbriqués ; l'écriture d'un WAV, la reconnaissance des formats ; les voix qui finissent à leur hauteur, en boucle, en fondu ; `SoundEffect` (variantes jamais répétées, volume et hauteur tirés, la plus ancienne voix arrêtée, le temps de recharge, dans le monde) ; `MusicPlayer` (le fondu enchaîné, le morceau en cours gardé, l'arrêt) ; `SceneAudio` (l'auditeur et les voix suivent leurs nœuds, un nœud retiré arrête ses voix, le composant retiré à la fin des voix, le système de la phase `render`) ; les chargeurs (un clip et un flux par le store, une erreur de décodage).
- **`engine-audio-native`** (sur miniaudio sans périphérique, avec l'addon) : le mix à son volume et à celui du bus, muet ; la fin d'une voix, la boucle, la pause, la reprise, la hauteur et le rééchantillonnage, le panoramique, la spatialisation (le côté, la distance, de face), le modèle linéaire muet au-delà de `maxDistance`, les fondus ; le décodage des quatre formats (et l'énergie d'un sinus), les erreurs, l'annulation ; les flux (la durée d'un Vorbis, deux voix d'un même flux, la boucle) ; un clip libéré qui joue encore ; `stopAll` ; trois cents voix finies dans une frame ; le départ en pause et à un décalage ; le périphérique par défaut ou nul.
- **`engine-audio-web`** (Chromium sans tête, mode navigateur de Vitest, des `OfflineAudioContext` suspendus aux temps voulus) : les mêmes vérifications que le natif, le décodage des quatre formats, un flux par un élément média sur un vrai `AudioContext`, le déverrouillage au premier geste.
- **`demo-scenes`** : le FPS sur le faux moteur (un bourdonnement par drone à sa place, l'auditeur aux yeux, les tirs, les coups au but, l'explosion dans le monde, le bourdonnement éteint ; la musique enchaînée quand la partie commence, tout arrêté à la destruction).
- **Documentation** : le tutoriel « L'audio » (EN, FR), son exemple vivant et ses captures (WebGPU, WebGL2) ; le guide « L'audio » ; la section « Les sons » du FPS.

## 8. La suite

1. **Des effets** : réverbération (une salle, la forêt du TPS), filtres passe-bas (l'occlusion du son par les murs, sous l'eau), compresseur sur le bus maître. WebAudio les a ; miniaudio a ses nœuds (`ma_lpf_node`, `ma_delay_node`).
2. **L'occlusion du son** par des rayons de la scène ou de la physique (P7b) : un mur entre la source et l'auditeur assourdit.
3. **Un nombre de voix global** avec des priorités (les voix lointaines et faibles volées les premières), au-delà de `SoundEffect.maxVoices`.
4. **Le TPS (P8)** : les pas sur les événements de l'animation graph (P6), les coups d'épée, l'ambiance de la forêt en flux.
5. **Les graphs de comportement (P9)** : des nœuds « jouer un son ».
6. **L'éditeur de jeu (P20)** : les bus et leurs curseurs, l'écoute des sons de la bibliothèque.

## 9. Décisions

1. **miniaudio en natif**, lié dans l'addon, à côté de SDL3 (§2.1).
2. **Deux sources : les clips décodés, les flux encodés** (§2.2).
3. **Une API d'interfaces** (moteur, bus, sources, voix, auditeur) ; les effets, la musique et la liaison à la scène écrits contre elle (§2.3).
4. **Les règles de WebAudio** pour le panoramique, l'atténuation et l'absence de Doppler, que le natif suit (§2.4).

## 10. État

**Faite** (17 octobre 2026) : `engine-audio` (l'API, `SoundEffect`, `MusicPlayer`, `SceneAudio`, les chargeurs, `FakeAudioEngine`, `encodeWav`), `engine-audio-web` (`WebAudioEngine`, `unlockAudio`), `engine-audio-native` (`NativeAudioEngine`), `fdw_audio` dans l'addon de `engine-native` (miniaudio 0.11.25, stb_vorbis) ; les sons du FPS, faits par le code, dans la démo web, la démo native et la page du FPS ; le tutoriel « L'audio » (EN, FR) avec son exemple vivant et ses captures, le guide « L'audio ». Reste la suite du §8.
