/**
 * Fixture: a lambda module whose body reaches for a binding that does not exist.
 * The `declare` is what lets the file type-check while still being wrong for the
 * engine — which is the point: only the guard can catch this one.
 */
import type { LambdaBindings } from "../../../src/index.js";

declare const $acc: number;

export default ({ $result }: LambdaBindings<"reduce">) => $result + $acc;
