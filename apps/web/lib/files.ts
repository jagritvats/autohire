import "server-only";
import { createFileStore, type FileStore } from "@jobflow/db";

/** User files (résumés, tailored PDFs) live in the data dir — never inside the source tree. */
let store: FileStore | null = null;
export function getFileStore(): FileStore {
  store ??= createFileStore();
  return store;
}
