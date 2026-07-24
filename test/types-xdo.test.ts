import { describe, it, expectTypeOf } from "vitest";
import type {
  StackItemXdo,
  TaggedValue,
  FunctionXdo,
  ConditionalContext,
} from "../src/types/xdo.js";

describe("xdo types", () => {
  it("a set_var-shaped object assigns to StackItemXdo", () => {
    const setVarItem: StackItemXdo = {
      name: "mvp:set_var",
      as: "x1",
      _xsid: "",
      addon: [],
      input: [],
      mocks: {},
      output: { items: [], filters: [], customize: false },
      context: { value: "123", tag: "const:int", filters: [] } satisfies TaggedValue,
      runtime: null,
      disabled: false,
      description: "",
      settings_registry: null,
    };
    expectTypeOf(setVarItem).toMatchTypeOf<StackItemXdo>();
  });

  it("a conditional context assigns to ConditionalContext", () => {
    const ctx: ConditionalContext = {
      expr: { expression: [] },
      if: { run: [] },
      elif: { run: [] },
      else: { run: [] },
    };
    expectTypeOf(ctx).toMatchTypeOf<ConditionalContext>();
  });

  it("FunctionXdo requires authored envelope fields", () => {
    expectTypeOf<FunctionXdo>().toHaveProperty("run");
    expectTypeOf<FunctionXdo>().toHaveProperty("result");
    expectTypeOf<FunctionXdo>().toHaveProperty("input");
  });

  it("rejects a stack item missing name (negative)", () => {
    // @ts-expect-error - `name` is required on StackItemXdo
    const bad: StackItemXdo = { as: "x1", context: {}, input: [] };
    void bad;
  });

  it("rejects an invalid tag (negative)", () => {
    // @ts-expect-error - "nope" is not a valid Tag
    const bad: TaggedValue = { value: "1", tag: "nope", filters: [] };
    void bad;
  });
});
