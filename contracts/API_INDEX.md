# Local API index

| API | Contract | Implementation |
| --- | --- | --- |
| Queued collection requests, results, decisions | [Request v1](README.md) | [contract](../service/contract.js), [worker](../service/worker.js), [HTTP](../service/server.js) |
| XHS two-round count/date card discovery and selected details | [Discovery sessions v1](discovery-sessions-v1.md) | [implementation record](../docs/DISCOVERY_SESSIONS.md), [service](../service/discovery_sessions.js) |
| External device control leases | [Service overview](../README.md#local-api) | [lease fencing](../service/store.js), [gateway](../service/device_gateway.js), [HTTP](../service/server.js) |

All APIs require existing local service authentication. Contracts describe source
behavior, not proof that a particular device operation has passed real acceptance.
