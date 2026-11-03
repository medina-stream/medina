/**
 * Medina's yielded/auth Stage 2 library: the auth contract, the
 * bucket-backed persistence ports, and the storage substrate they
 * share. See README.md in this directory for the design notes and
 * what the integration step still has to wire.
 */
export {
  AUTH_NAMESPACE,
  SESSION_MODULE_ID,
  SessionClaims,
  authContract,
  sessionContract,
} from "./contract.ts";
export {
  ObjectStore,
  ObjectStoreFailure,
  layerMemory,
  layerR2,
  makeMemoryObjectStore,
  makeR2ObjectStore,
  type ObjectStoreShape,
  type PutCondition,
  type PutResult,
  type R2BucketBindingLike,
  type StoredObject,
} from "./ObjectStore.ts";
export {
  layerPasswordPersistence,
  makePasswordPersistence,
} from "./PasswordPersistence.ts";
export { makeSessionPersistence } from "./SessionPersistence.ts";
export {
  provisionSubject,
  registerPassword,
} from "./subjects.ts";
