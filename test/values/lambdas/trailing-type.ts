/**
 * Fixture: a type declared AFTER the default export. Legal TypeScript, and the
 * extraction must not swallow it into the body.
 */
import type { LambdaBindings } from "../../../src/index.js";

export default ({ $this }: LambdaBindings<"map">) => {
  const row: Row = $this;
  return row.n * 2;
};

type Row = { n: number };
