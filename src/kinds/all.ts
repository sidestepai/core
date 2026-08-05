/**
 * Side-effect barrel: importing this module registers every object kind on the
 * kind registry. Each kind module self-registers at load (`registerKind(...)`),
 * so a single import here guarantees the registry is fully populated — used by
 * the manifest builder so its coverage reflects reality regardless of caller.
 */
import "./function.js";
import "./trigger.js";
import "./toolset.js";
import "./mcp-server.js";
import "./agent.js";
import "./table.js";
import "./query.js";
import "./api-group.js";
import "./task.js";
import "./workflow-test.js";
import "./middleware.js";
import "./addon.js";
import "./microservice.js";
import "./realtime-server.js";
import "./realtime-channel.js";
import "./realtime-message.js";
import "./workspace-config.js";
