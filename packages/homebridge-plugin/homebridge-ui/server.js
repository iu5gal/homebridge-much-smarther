// Server side of the setup UI, run by the Homebridge UI in its own process.
// The requests themselves are in src/ui-handlers.ts; this file only wires
// them to the Homebridge UI and turns their errors into translatable keys.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { retrievePswOpen } from '@much-smarther/core/cloud';
import { createUiHandlers, UiError } from '../dist/ui-handlers.js';

class MuchSmartherUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const handlers = createUiHandlers({ storagePath: this.homebridgeStoragePath ?? '', retrievePswOpen });
    for (const [path, handler] of Object.entries(handlers)) {
      this.onRequest(path, async (payload) => {
        try {
          return await handler(payload);
        } catch (error) {
          // Never pass on messages from below: they could carry details the UI must not show.
          if (error instanceof UiError) throw new RequestError(error.key, { key: error.key, ...error.details });
          throw new RequestError('ui.error.failed', { key: 'ui.error.failed' });
        }
      });
    }
    this.ready();
  }
}

(() => new MuchSmartherUiServer())();
