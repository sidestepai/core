import { describe, it, expect } from "vitest";
import { encodeContainerHistory } from "../../src/kinds/history.js";

/**
 * The realtime container tier (`message_enabled`/`message_limit`, carried by
 * both a realtime server and a channel) defaults **off** — message history is a
 * hot path. That is the opposite of the `query`/`tool` container default, which
 * the encoder previously hardcoded.
 */
describe("container history — message tier", () => {
  it("defaults to inherit, off", () => {
    expect(encodeContainerHistory("message")).toEqual({
      inherit: true,
      message_enabled: false,
      message_limit: 100,
    });
  });

  it("customizes on with the default depth", () => {
    expect(encodeContainerHistory("message", true)).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: 100,
    });
  });

  it("customizes off explicitly", () => {
    expect(encodeContainerHistory("message", false)).toEqual({
      inherit: false,
      message_enabled: false,
      message_limit: 100,
    });
  });

  it("customizes a capture depth, and unlimited", () => {
    expect(encodeContainerHistory("message", 25)).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: 25,
    });
    expect(encodeContainerHistory("message", "all")).toEqual({
      inherit: false,
      message_enabled: true,
      message_limit: -1,
    });
  });

  it("rejects an invalid numeric depth", () => {
    expect(() => encodeContainerHistory("message", -1)).toThrow(/non-negative integer/);
    expect(() => encodeContainerHistory("message", 1.5)).toThrow(/non-negative integer/);
  });

  it("leaves the query and tool tiers defaulting ON (regression guard)", () => {
    expect(encodeContainerHistory("query")).toEqual({
      inherit: true,
      query_enabled: true,
      query_limit: 100,
    });
    expect(encodeContainerHistory("tool")).toEqual({
      inherit: true,
      tool_enabled: true,
      tool_limit: 100,
    });
  });
});
