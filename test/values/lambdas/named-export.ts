/** Fixture: a second export beside the default — undefined at runtime. */
import type { LambdaBindings } from "../../../src/index.js";

export const helper = (n: number): number => n * 2;

export default ({ $this }: LambdaBindings<"map">) => helper($this);
