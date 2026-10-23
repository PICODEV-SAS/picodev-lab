/**
 * Named virtual I2C devices a setup can attach to the bus.
 * ========================================================
 *
 * Some challenges have a second (controller) board that is an I2C slave on the bench,
 * but avr8js can't emulate a slave — so in the sim a virtual JS device answers at that
 * address instead, clocked off the controller board so its state matches the real
 * firmware the controller runs. A `controllers[].i2cDevice` name in the sheet selects
 * one of these, and the bench registers it on the main board's bus. A device takes what
 * is secret from the session (`secrets`, pushed by the hub), never from its own code.
 */
import type { I2CDevice } from '@velxio/simulation/I2CBusManager';
import { GhostlightDevice, OFFLINE_FLAG } from './GhostlightDevice';

export type VirtualI2cDeviceFactory = (nowMs: () => number, secrets: Readonly<Record<string, string>>) => I2CDevice;

const registry = new Map<string, VirtualI2cDeviceFactory>([
  ['ghostlight', (nowMs, secrets) => new GhostlightDevice(nowMs, secrets.flag ?? OFFLINE_FLAG)],
]);

export function getVirtualI2cDevice(name: string): VirtualI2cDeviceFactory | undefined {
  return registry.get(name);
}
