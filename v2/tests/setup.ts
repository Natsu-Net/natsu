/**
 * Test preload. natsu's registries are module-global by design (that is what
 * `globalThis.Router` means), so the suite silences logging once here and each
 * file resets the registries itself.
 */

import { setColorEnabled, setLogSink } from "../src/logger.ts";

setColorEnabled(false);
setLogSink(() => {});
