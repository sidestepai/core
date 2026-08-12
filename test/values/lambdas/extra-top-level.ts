/** Fixture: a helper beside the default export — absent at runtime, so refused. */
import type { LambdaBindings } from "../../../src/index.js";

const double = (n: number): number => n * 2;

export default ({ $this }: LambdaBindings<"map">) => double($this);
