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
any local command is active. Manual and scheduled connection repairs use the same supervisor checks before clearing a phone’s quarantine.

The service holds an OS lock on the queue and device directories. Linux releases
ownership when the process exits. A fresh start replaces the PID marker and
resets leases and command reservations in one transaction. Interrupted work
returns to the queue with its checkpoint and results. Normal shutdown performs
the same cleanup after draining the workers.

If an interrupted command remains in the ledger, its phone stays isolated until
the operator or trusted supervisor verifies that input stopped. Other devices can
accept work immediately. Existing quarantines retain their recorded causes.

The first quarantine repair is due after five seconds. Each failure doubles the interval up to 24 hours. At that limit retries continue daily. The service reconstructs the next deadline from the current incident’s persistent events.
