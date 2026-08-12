/**
 * Fixture: the shape `lam.file` expects — one default-exported function whose
 * first parameter destructures the bindings for its surface.
 */
import type { LambdaBindings } from "../../../src/index.js";

export default ({ $result, $this }: LambdaBindings<"reduce">) => {
  const line = $this.qty * $this.price;
  return $result + line;
};
