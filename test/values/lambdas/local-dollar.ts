/**
 * Fixture: a body that declares its own `$`-prefixed names. `$` is a legal
 * identifier character, so these are the author's locals, not engine bindings.
 */
import type { LambdaBindings } from "../../../src/index.js";

export default ({ $parent }: LambdaBindings<"map">) => {
  const $tally = $parent.reduce(($sum: number, $n: number) => $sum + $n, 0);
  return $tally;
};
