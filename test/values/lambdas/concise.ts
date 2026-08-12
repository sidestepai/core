/** Fixture: the concise-expression form of a lambda module. */
import type { LambdaBindings } from "../../../src/index.js";

export default ({ $this }: LambdaBindings<"map">) => $this * 2;
