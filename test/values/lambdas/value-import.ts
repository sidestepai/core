/**
 * Fixture: a VALUE import at the top level. The module is never loaded by the
 * engine, so the binding would be undefined inside the body.
 */
import { join } from "node:path";

export default () => join("a", "b");
