import type {RustBackend, RustColumns, RustStoreSource} from 'barochart/wasm';
import type {JavaScriptMigrationCapture} from 'barochart/wasm-migration';

declare const backend: RustBackend;
declare const columns: RustColumns;
declare const source: RustStoreSource;
declare const capture: JavaScriptMigrationCapture;

const options = {
  columns,
  document: capture.metadataJSON,
  binding: capture.description,
  source,
  size: {width: 640, height: 360},
};
void backend.createSessionFromWorkspace(options);
void backend.createSessionFromMigration(capture);
