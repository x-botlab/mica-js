/**
 * Schema version of the `.scene3d` contract.
 *
 * A reader must reject documents whose `version` it does not understand. Bump this constant when
 * the format changes in a backwards-incompatible way.
 */
export const SCENE3D_VERSION = 1;

/** Version literal carried by every {@link Scene3DDocument}. */
export type Scene3DVersion = typeof SCENE3D_VERSION;
