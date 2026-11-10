# Trusted gateway recovery

Device commands and Android quarantine are the durable recovery owner. A running
command, an unknown command or a quarantined device keeps `requiresRecovery()`
true. Database read failures fail closed.

The gateway retains per-device memory uncertainty only when cancellation could
not persist its quarantine/stopping barriers, or a supervisor removed an orphan
command without yet recovering its device. Clearing an orphan command alone is
not recovery. The local supervisor must independently prove remote input stopped,
then call `gateway.recoverDevice(id, {stopped:true, platform})`. This invokes the
existing store recovery guards (no active command or device lease) and clears only
that device's memory uncertainty after store recovery succeeds. A failed recovery
or recovery of another device cannot clear it. The gateway refuses recovery while
any local command is active. No HTTP recovery endpoint or automatic unlock exists.

Normal shutdown drains work and retains an unsafe verdict even after the owner
closes SQLite. With all inputs stopped and corresponding trusted recoveries
complete, normal shutdown can release its own guardian through the existing IPC.

A service already running older code can retain its prior sticky memory flag.
A separately authorized one-time operational recovery may therefore be required:
stop the dedicated API so it cannot dispatch during the switch, normally stop the
crawler main, independently recheck remote input/commands/leases, validate the exact
old guardian PID, process start time, script and lock identity, stop only that idle
guardian, verify its exit, then atomically archive its unchanged orphan lock for
audit. Never archive a lock with a live owner or remove an unverified lock. Any
identity, input, lease or state mismatch stops the procedure. Preserve device
contracts, unrelated processes, queue history and other devices.
