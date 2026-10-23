import { fileURLToPath } from 'node:url';

/** Absolute path of the prebuilt single-page app, for static hosting by the workflow server. */
export const webDistDir = fileURLToPath(new URL('./dist/', import.meta.url));
