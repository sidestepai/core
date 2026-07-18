import { defineFunction, input, setVar, ref, c } from "../../src/index.js";

/**
 * Test fixture: default-exports a function (not a Xano), used to assert that
 * `export` rejects modules that don't default-export a Xano instance.
 */
export default defineFunction({
  name: "omg1",
  input: {
    name: input.text({ required: false, methods: ["trim"] }),
  },
  stack: [setVar("x1", c.int(123))],
  response: ref("x1"),
});
