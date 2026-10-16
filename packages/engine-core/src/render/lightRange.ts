import { BaseLight, PointLight, SpotLight } from '../light';

/**
 * The light received below which a point or spot light is ignored: a
 * fraction of its strongest color component, about one step of an 8-bit
 * color.
 */
export const LightThreshold = 1 / 256;

/**
 * The distance beyond which a point or spot light gives less than
 * LightThreshold of its intensity: where its attenuation 1 / (c + l d + q d²)
 * falls below the threshold. Infinity for a directional light, or a light
 * without attenuation.
 */
export function lightRange(light: BaseLight): number {
  if (!(light instanceof PointLight || light instanceof SpotLight)) {
    return Infinity;
  }
  // The ambient term is attenuated too.
  const intensity = Math.max(
    ...[light.ambient, light.diffuse, light.specular].flatMap(({ x, y, z }) => [
      x,
      y,
      z,
    ]),
  );
  if (intensity <= 0) {
    return 0;
  }
  // c + l d + q d² = intensity / threshold.
  const target = intensity / LightThreshold;
  const c = light.constantAttenuation;
  const l = light.linearAttenuation;
  const q = light.quadraticAttenuation;
  if (c >= target) {
    return 0;
  }
  if (q > 0) {
    return (-l + Math.sqrt(l * l + 4 * q * (target - c))) / (2 * q);
  }
  if (l > 0) {
    return (target - c) / l;
  }
  return Infinity;
}
