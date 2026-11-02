import type { API } from 'homebridge';
import { MuchSmartherPlatform, PLATFORM_NAME, PLUGIN_NAME } from './platform.js';

export { PLATFORM_NAME, PLUGIN_NAME };

/** Homebridge entry point. */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MuchSmartherPlatform);
};
