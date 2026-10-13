package dev.aster.charts;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Executes the actual package-private production helper, without Android, JNI or JSON stubs. */
public final class WorkspaceRestoreJobHarness {
    private static final long WAIT_MILLIS = 5000;
    private static int scenarios;
    private static int checks;
    private static String scenario;

    private WorkspaceRestoreJobHarness() {}

    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(scenario + ": " + message);
    }

    private static void invariant(boolean condition, String message) {
        if (!condition) throw new AssertionError(scenario + ": " + message);
    }

    private interface Checked { void run() throws Exception; }
    private interface Predicate { boolean get(); }

    private static void test(String name, Checked body) throws Exception {
        String filter = System.getProperty("aster.test.filter");
        if (filter != null && !name.contains(filter)) return;
        scenario = name;
        long[] before = WorkspaceRestoreJob.budgetForTest();
        invariant(Arrays.equals(before, new long[] {0, 0}), "previous scenario left a budget reservation");
        body.run();
        check(Arrays.equals(before, WorkspaceRestoreJob.budgetForTest()), "global budget returns to entry baseline");
        scenarios++;
        System.out.println("PASS " + name);
    }

    private static void await(CountDownLatch latch, String operation) throws InterruptedException {
        invariant(latch.await(WAIT_MILLIS, TimeUnit.MILLISECONDS), "timeout waiting for " + operation);
    }

    /** Bounded FIFO. Only its owner (normally main) executes tasks; workers only enqueue. */
    private static final class OwnerQueue {
        final Thread owner = Thread.currentThread();
        final ArrayBlockingQueue<Runnable> tasks = new ArrayBlockingQueue<Runnable>(128);
        final List<Runnable> delivered = new ArrayList<Runnable>();
        final AtomicInteger rejectNext = new AtomicInteger();
        final AtomicInteger throwNext = new AtomicInteger();
        final AtomicInteger delayedPosts = new AtomicInteger();
        volatile boolean unavailable;
        volatile boolean rejectDelayed;
        volatile boolean throwDelayed;
        volatile RuntimeException initialRuntimeFailure;
        volatile Error initialErrorFailure;
        volatile boolean enqueueBeforeInitialThrow;
        volatile CountDownLatch handoffPostEntered;
        volatile CountDownLatch handoffPostResume;
        volatile Thread handoffWorker;
        volatile boolean captureNextWorkerPost;
        volatile boolean holdNextWorkerPost;
        volatile Runnable held;

        boolean post(Runnable action) {
            if (initialRuntimeFailure != null || initialErrorFailure != null) {
                if (enqueueBeforeInitialThrow) invariant(tasks.offer(action), "test late initial enqueue fits bounded queue");
                RuntimeException runtime = initialRuntimeFailure; Error error = initialErrorFailure;
                initialRuntimeFailure = null; initialErrorFailure = null;
                if (runtime != null) throw runtime;
                throw error;
            }
            if (throwNext.get() > 0 && throwNext.getAndDecrement() > 0) throw new AssertionError("injected owner enqueue throwable");
            if (holdNextWorkerPost && Thread.currentThread() == handoffWorker) { holdNextWorkerPost = false; held = action; return true; }
            if (unavailable) return false;
            if (rejectNext.get() > 0 && rejectNext.getAndDecrement() > 0) return false;
            if (captureNextWorkerPost && Thread.currentThread() == handoffWorker) {
                captureNextWorkerPost = false;
                boolean accepted = tasks.offer(action);
                handoffPostEntered.countDown();
                try { await(handoffPostResume, "handoff post resume"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                return accepted;
            }
            return tasks.offer(action);
        }

        boolean postDelayed(Runnable action) {
            delayedPosts.incrementAndGet();
            if (throwDelayed) throw new AssertionError("injected delayed owner enqueue throwable");
            return !rejectDelayed && post(action);
        }

        void tick() throws Exception {
            invariant(Thread.currentThread() == owner, "queue delivered away from its owner");
            Runnable action = tasks.poll(5, TimeUnit.MILLISECONDS);
            if (action != null) { delivered.add(action); action.run(); }
        }

        void until(Predicate done) throws Exception {
            long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WAIT_MILLIS);
            while (!done.get() && System.nanoTime() < end) tick();
            invariant(done.get(), "owner queue timed out");
        }

        void drain() throws Exception {
            int count = 0;
            while (!tasks.isEmpty()) { invariant(++count <= 1024, "unbounded queued callback drain"); tick(); }
        }

        void runOnOwner(Checked action) throws Exception {
            if (Thread.currentThread() == owner) { action.run(); return; }
            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
            invariant(post(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } finally { done.countDown(); } }), "test mutation enqueue rejected");
            await(done, "test owner mutation");
            Throwable error = failure.get();
            if (error != null) throw new IllegalStateException("test owner mutation failed", error);
        }
    }

    /** Independent ledger: never delegates validation or ownership tracking to the implementation. */
    private static final class FakeHost implements WorkspaceRestoreJob.Host {
        final OwnerQueue queue;
        final long original;
        final long expectedTicket;
        final long capturedRegistration;
        final long foreignRegistration;
        final Set<Long> registrations = new HashSet<Long>();
        final Set<Long> live = new HashSet<Long>();
        final Set<Long> freed = new HashSet<Long>();
        final List<String> events = new ArrayList<String>();
        final List<String> violations = new ArrayList<String>();
        volatile long handle;
        volatile long revision = 11;
        volatile boolean isClosed;
        volatile WorkspaceRestoreJob active;
        volatile WorkspaceRestoreJob job;
        volatile Thread worker;
        volatile String stage;
        String hookStage;
        Checked hook;
        boolean hookUsed;
        int length = 3;
        long logicalBytes = 4096;
        int pendingAdmissions;
        volatile int completeCount;
        volatile String status;
        volatile Throwable terminalError;
        WorkspaceRestoreJob.Metrics metrics;
        volatile long target;
        long ticket;
        int created;
        int publicationCount;
        int effectiveSourceReleases;
        int sourceFinishCount;
        int beginCalls;
        int sourceReleaseCalls;
        int unknownTicketAbortCalls;
        boolean beginResponseLost;
        long beginResultOverride = Long.MIN_VALUE;
        int releaseBeforeFailures;
        int releaseAfterFailures;
        int reservationReleases;
        int observerCount;
        int errorCallbackCount;
        int progressCount;
        int reads;
        int writes;
        long bytesWritten;
        int steps;
        int computeSteps = 2;
        long lastProgressDone;
        String lastProgressPhase;
        Checked computeProgress;
        int[] nextOffset = new int[6];
        boolean throwProgress;
        boolean throwObserver;
        boolean throwComplete;
        boolean throwDiagnostics;
        boolean throwRetiredFree;
        boolean shortRead;
        boolean mismatchedDescriptor;
        boolean sourceReleasedAtPublish;
        boolean workerStoppedAtPublish;
        boolean reservationGoneAtObserver;
        boolean zeroRetainedAtCompleteExceptHost;
        boolean rejectPublish;
        boolean holdHandoff;
        Checked observer;
        Checked completion;
        final CountDownLatch targetFinished = new CountDownLatch(1);
        CountDownLatch publishEntered;
        CountDownLatch cancelAttempted;

        FakeHost(OwnerQueue queue, long original) {
            this.queue = queue; this.original = original; handle = original;
            expectedTicket = original + 700; capturedRegistration = original + 200000; foreignRegistration = original + 200001;
            live.add(original);
        }

        synchronized void event(String value) { events.add(value); }
        synchronized void verify(boolean condition, String message) {
            if (!condition) { violations.add(message); throw new IllegalStateException("fake host invariant: " + message); }
        }
        void owner() { verify(Thread.currentThread() == queue.owner, "owner-only operation used off owner thread"); }
        void worker() {
            verify(Thread.currentThread() != queue.owner, "worker operation ran on owner thread");
            if (worker == null) worker = Thread.currentThread();
            verify(worker == Thread.currentThread(), "more than one worker accessed target");
        }
        void hit(String value) throws Exception {
            stage = value;
            event(value);
            Checked action = null;
            synchronized (this) { if (!hookUsed && value.equals(hookStage)) { hookUsed = true; action = hook; } }
            if (action != null) action.run();
        }
        void liveSource(long source, long sourceTicket) {
            owner();
            verify(source == original, "old ticket used with replacement handle");
            verify(sourceTicket == expectedTicket, "incorrect source ticket");
            verify(live.contains(source), "operation used a freed source");
        }
        public void requireOwner() { owner(); }
        public long currentHandle() { owner(); return handle; }
        public long currentRevision() { owner(); return revision; }
        public boolean closed() { owner(); return isClosed; }
        public boolean current(WorkspaceRestoreJob candidate) { owner(); return candidate == active; }
        public boolean post(Runnable action) { return queue.post(action); }
        public boolean postDelayed(Runnable action, long delayMillis) {
            verify(delayMillis > 0, "nonpositive handoff retry delay"); return queue.postDelayed(action);
        }
        public long beginSource(long source, String document, String binding, long sourceRevision) throws Exception {
            owner(); beginCalls++; verify(source == original && sourceRevision == 11, "wrong initial source identity");
            verify("workspace".equals(document) && "binding".equals(binding), "input snapshot changed");
            verify(ticket == 0, "source admission started twice");
            hit("begin"); // Failure here precedes registration; later failures may follow side effects.
            if (!live.contains(source)) throw new IllegalStateException("source closed during admission");
            verify(registrations.add(capturedRegistration), "captured registration allocated twice");
            ticket = expectedTicket;
            if (beginResponseLost) throw new IllegalStateException("begin registered source but its response was lost");
            return beginResultOverride == Long.MIN_VALUE ? ticket : beginResultOverride;
        }
        public WorkspaceRestoreJob.Admission admitSource(long source, long sourceTicket, int records, long sourceRevision) throws Exception {
            liveSource(source, sourceTicket); verify(records == 8, "unbounded admission quantum");
            hit("admission");
            if (pendingAdmissions-- > 0) return new WorkspaceRestoreJob.Admission(1, null);
            return new WorkspaceRestoreJob.Admission(2, new WorkspaceRestoreJob.Descriptor(
                mismatchedDescriptor ? sourceTicket + 1 : sourceTicket, "metadata", length, logicalBytes));
        }
        public void checkSource(long source, long sourceTicket, long sourceRevision) throws Exception {
            liveSource(source, sourceTicket); verify(ticket == sourceTicket, "source checked after release");
            verify(sourceRevision == 11, "captured revision changed"); hit("source-check");
        }
        public byte[] readSource(long source, long sourceTicket, int slot, int offset, int count) throws Exception {
            liveSource(source, sourceTicket); verify(ticket == sourceTicket, "source read after release");
            verify(slot >= 0 && slot < 6 && offset >= 0 && count > 0 && count <= 262144 && offset + count <= length, "unbounded source read");
            hit("copy-read"); reads++;
            byte[] bytes = new byte[count * 8 - (shortRead ? 1 : 0)];
            Arrays.fill(bytes, (byte) (slot + 1)); return bytes;
        }
        public void finishSource(long source, long sourceTicket, long sourceRevision) throws Exception {
            liveSource(source, sourceTicket); sourceFinishCount++;
            releaseTicket(); // Callback-capable cleanup happens before the final publish predicate.
            hit("source-finish");
        }
        public void releaseSource(long source, long sourceTicket) throws Exception {
            owner(); verify(source == original && live.contains(source), "abort used wrong or freed source handle");
            verify(sourceTicket == expectedTicket || sourceTicket == -1, "abort used neither validated ticket nor unknown-ticket sentinel");
            sourceReleaseCalls++; if (sourceTicket == -1) unknownTicketAbortCalls++;
            // Even without a returned ticket, this Host owns exactly one captured registration.
            // A foreign token in the same runtime must survive this abort.
            if (releaseBeforeFailures-- > 0) throw new IllegalStateException("source disposal failed before side effect");
            releaseTicket(); hit("source-release");
            if (releaseAfterFailures-- > 0) throw new IllegalStateException("source disposal failed after side effect");
        }
        void releaseTicket() {
            boolean owned = registrations.remove(capturedRegistration);
            if (ticket != 0) { verify(owned, "ticket lost its captured registration"); ticket = 0; effectiveSourceReleases++; event("ticket-released"); }
        }
        public long createTarget(String metadata) throws Exception {
            worker(); verify("metadata".equals(metadata), "wrong descriptor metadata");
            hit("target-create"); // Atomic-on-throw: no target exists if this hook throws.
            synchronized (this) { target = original + 10000; verify(live.add(target), "duplicate target allocation"); created++; }
            return target;
        }
        public void writeTarget(long candidate, int slot, int offset, byte[] bytes) throws Exception {
            worker(); verify(candidate == target && live.contains(candidate), "write to unowned target");
            verify(offset == nextOffset[slot], "noncontiguous target transfer");
            for (byte value : bytes) verify(value == (byte) (slot + 1), "source data changed in transit");
            hit("copy-write"); nextOffset[slot] += bytes.length / 8; writes++; bytesWritten += bytes.length;
        }
        public void startTarget(long candidate) throws Exception {
            worker(); verify(candidate == target && live.contains(candidate), "start unowned target");
            for (int offset : nextOffset) verify(offset == length, "target started before complete six-column transfer");
            hit("compute-start");
        }
        public WorkspaceRestoreJob.Progress stepTarget(long candidate, int bars) throws Exception {
            worker(); verify(candidate == target && live.contains(candidate), "step unowned target");
            verify(bars == 17, "configured compute quantum changed"); hit("compute"); steps++;
            return new WorkspaceRestoreJob.Progress("compute", steps, computeSteps, steps == computeSteps);
        }
        public void finishTarget(long candidate) throws Exception {
            worker(); verify(candidate == target && live.contains(candidate), "finish unowned target");
            hit("target-finish");
            if (holdHandoff) { queue.handoffWorker = Thread.currentThread(); queue.holdNextWorkerPost = true; }
            targetFinished.countDown();
        }
        public synchronized void free(long candidate) {
            verify(live.remove(candidate), "double free or unknown native handle " + candidate);
            verify(freed.add(candidate), "handle freed twice " + candidate);
            event("free:" + candidate);
            if (candidate == original && throwRetiredFree) throw new IllegalStateException("retired cleanup callback");
        }
        public void publish(WorkspaceRestoreJob candidate, long source, long prepared, long sourceRevision) {
            owner();
            // Callback-free atomic compare/swap; the test never runs a callback inside publish.
            synchronized (this) {
                verify(source == original && prepared == target && live.contains(prepared), "publish ownership changed");
                if (rejectPublish || handle != source || revision != sourceRevision || isClosed || active != candidate) throw new IllegalStateException("publish compare/swap rejected");
                sourceReleasedAtPublish = ticket == 0;
                workerStoppedAtPublish = worker != null && !worker.isAlive();
                verify(sourceReleasedAtPublish, "publication preceded source fence release");
                verify(workerStoppedAtPublish, "publication overlapped target worker");
                if (publishEntered != null) {
                    publishEntered.countDown();
                    try { await(cancelAttempted, "concurrent cancellation attempt"); }
                    catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IllegalStateException(error); }
                }
                handle = prepared; publicationCount++; event("published");
            }
        }
        public void releaseReservation(WorkspaceRestoreJob candidate) {
            owner(); reservationReleases++;
            if (active == candidate) active = null;
            event("reservation-released");
        }
        public void notifyObservers() {
            owner(); observerCount++;
            reservationGoneAtObserver = active == null && Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {0, 0});
            event("observer");
            try { if (observer != null) observer.run(); } catch (Exception error) { throw new IllegalStateException(error); }
            if (throwObserver) throw new IllegalStateException("observer callback");
        }
        public void onProgress(String phase, long done, long total) {
            owner(); progressCount++; lastProgressDone = done; lastProgressPhase = phase; verify(completeCount == 0, "progress after completion");
            if ("compute".equals(phase) && computeProgress != null) try { computeProgress.run(); } catch (Exception callback) { throw new IllegalStateException(callback); }
            if (throwProgress) throw new IllegalStateException("progress callback");
        }
        public void onComplete(String result, Throwable error, WorkspaceRestoreJob.Metrics value) {
            owner(); completeCount++; status = result; terminalError = error; metrics = value;
            long[] retained = job.retainedForTest();
            zeroRetainedAtCompleteExceptHost = retained[1] == 0 && retained[2] == 0 && retained[3] == 0 && retained[4] == 0 && retained[5] == 0;
            event("complete:" + result);
            try { if (completion != null) completion.run(); } catch (Exception callback) { throw new IllegalStateException(callback); }
            if (throwComplete) throw new IllegalStateException("completion callback");
        }
        public void onCallbackError(Throwable error) {
            owner(); errorCallbackCount++; if (throwDiagnostics) throw new IllegalStateException("diagnostic callback");
        }
        WorkspaceRestoreJob start() {
            job = new WorkspaceRestoreJob(this, "workspace", "binding", 10000, 17);
            active = job; job.start(); return job;
        }
        void changeRevision() { owner(); revision++; }
        void replaceSource() {
            owner(); releaseTicket(); free(handle); handle = original + 20000; live.add(handle);
        }
        void closeSource() {
            owner(); isClosed = true; releaseTicket(); if (live.contains(handle)) free(handle); handle = 0; job.closeOnOwner();
        }
        void finish(String expected) throws Exception {
            queue.until(() -> completeCount > 0);
            Thread actualWorker = worker;
            if (actualWorker != null) { actualWorker.join(WAIT_MILLIS); invariant(!actualWorker.isAlive(), "worker survived completion"); }
            queue.drain();
            check(expected.equals(status), "expected " + expected + ", got " + status + " (" + terminalError + ")");
            check(completeCount == 1, "completion exactly once");
            check(violations.isEmpty(), "host ownership invariant failures: " + violations);
            check(reservationReleases == 1, "host busy reservation released once");
            check(ticket == 0, "source ticket released");
            check(effectiveSourceReleases <= 1, "source ticket freed at most once");
            check(Arrays.equals(job.retainedForTest(), new long[] {0, 0, 0, 0, 0, 0}), "terminal job releases all retained references");
            check(zeroRetainedAtCompleteExceptHost, "retained inputs and worker cleared before completion callback");
            check(publicationCount == ("success".equals(expected) ? 1 : 0), "publish exactly on success");
            check(job.committed() == "success".equals(expected), "commit state is terminal and accurate");
            check(created == 0 || ("success".equals(expected) ? live.contains(target) && !freed.contains(target) : freed.contains(target) && !live.contains(target)), "single target owner after terminal");
            check(handle == 0 ? live.isEmpty() : live.size() == 1 && live.contains(handle), "only current engine handle remains live");
        }
    }

    private static FakeHost host() { return new FakeHost(new OwnerQueue(), 101); }

    private static void inject(FakeHost host, String stage, String mode) {
        host.hookStage = stage;
        host.hook = () -> {
            if ("throw".equals(mode)) throw new IllegalStateException("injected " + stage);
            if ("cancel".equals(mode)) host.job.cancel();
            else if ("stale".equals(mode)) host.queue.runOnOwner(host::changeRevision);
            else if ("closed".equals(mode)) host.queue.runOnOwner(host::closeSource);
        };
    }

    private static void queuedHandoff(FakeHost host) throws Exception {
        host.queue.until(() -> host.targetFinished.getCount() == 0);
        host.worker.join(WAIT_MILLIS);
        invariant(!host.worker.isAlive(), "target worker did not stop before queued handoff");
        invariant(host.queue.held != null && host.queue.tasks.offer(host.queue.held), "held handoff returned to bounded owner queue");
        host.queue.held = null;
    }

    private static WorkspaceRestoreJob prepareInitialJob(FakeHost host) {
        WorkspaceRestoreJob value = new WorkspaceRestoreJob(host, "workspace", "binding", 10000, 17);
        host.job = value; host.active = value; return value;
    }

    private static void assertInitialDiscard(FakeHost host, WorkspaceRestoreJob rejected, WorkspaceRestoreJob expectedActive) throws Exception {
        host.queue.drain(); rejected.start(); rejected.cancel(); rejected.closeOnOwner(); rejected.discardBeforeStart();
        check(Arrays.equals(rejected.retainedForTest(), new long[] {0, 0, 0, 0, 0, 0}), "initial throwing call retains no host, input, worker or target");
        check(host.completeCount == 0 && host.progressCount == 0 && host.observerCount == 0 && host.errorCallbackCount == 0, "initial throwing call owes no callbacks");
        check(host.beginCalls == 0 && host.ticket == 0 && host.sourceReleaseCalls == 0, "failed initial enqueue never enters source protocol");
        check(host.created == 0 && host.worker == null, "failed initial enqueue starts no target worker");
        check(host.reservationReleases == 1 && host.active == expectedActive, "release is bound to rejected reservation identity");
        check(host.handle == host.original && host.live.size() == 1 && host.live.contains(host.original) && host.freed.isEmpty(), "original engine handle remains untouched");
        check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {0, 0}), "initial throwing call owns no global budget");
        check(!rejected.committed() && !rejected.pendingOwnerCleanup(), "discarded initial job is neither committed nor pending cleanup");
        check(host.violations.isEmpty() && host.queue.tasks.isEmpty(), "late start callbacks cannot mutate discarded job");
    }

    private static void initialEnqueueOwnership() throws Exception {
        test("initial-enqueue-accepted-is-deferred", () -> {
            FakeHost host = host(); prepareInitialJob(host).enqueueInitial();
            check(host.beginCalls == 0 && host.completeCount == 0 && host.queue.tasks.size() == 1, "accepted initial enqueue does not run source or callbacks inline");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {0, 0}), "initial owner queue entry precedes global admission");
            host.finish("success");
        });
        test("initial-enqueue-false-discards-before-source", () -> {
            FakeHost host = host(); WorkspaceRestoreJob value = prepareInitialJob(host); host.queue.rejectNext.set(1);
            Throwable thrown = null; try { value.enqueueInitial(); } catch (Throwable error) { thrown = error; }
            check(thrown instanceof IllegalStateException, "rejected initial enqueue throws to synchronous caller");
            assertInitialDiscard(host, value, null);
        });
        test("initial-enqueue-runtime-throw-preserves-error", () -> {
            FakeHost host = host(); WorkspaceRestoreJob value = prepareInitialJob(host);
            RuntimeException expected = new IllegalStateException("original initial enqueue exception"); host.queue.initialRuntimeFailure = expected;
            Throwable thrown = null; try { value.enqueueInitial(); } catch (Throwable error) { thrown = error; }
            check(thrown == expected, "initial scheduling RuntimeException identity is preserved");
            assertInitialDiscard(host, value, null);
        });
        test("initial-enqueue-error-throw-preserves-error", () -> {
            FakeHost host = host(); WorkspaceRestoreJob value = prepareInitialJob(host);
            Error expected = new AssertionError("original initial enqueue Error"); host.queue.initialErrorFailure = expected;
            Throwable thrown = null; try { value.enqueueInitial(); } catch (Throwable error) { thrown = error; }
            check(thrown == expected, "initial scheduling Error identity is preserved");
            assertInitialDiscard(host, value, null);
        });
        test("initial-enqueue-queued-then-throw-late-start-inert", () -> {
            FakeHost host = host(); WorkspaceRestoreJob value = prepareInitialJob(host);
            Error expected = new AssertionError("queued then threw outside Host contract"); host.queue.initialErrorFailure = expected; host.queue.enqueueBeforeInitialThrow = true;
            Throwable thrown = null; try { value.enqueueInitial(); } catch (Throwable error) { thrown = error; }
            check(thrown == expected && host.queue.tasks.size() == 1, "out-of-contract queue retains a late start after throwing");
            assertInitialDiscard(host, value, null);
        });
        test("initial-enqueue-failure-preserves-new-reservation", () -> {
            FakeHost host = host(); WorkspaceRestoreJob rejected = prepareInitialJob(host);
            WorkspaceRestoreJob replacement = new WorkspaceRestoreJob(host, "workspace", "binding", 10000, 17);
            host.active = replacement; host.queue.rejectNext.set(1);
            Throwable thrown = null; try { rejected.enqueueInitial(); } catch (Throwable error) { thrown = error; }
            check(thrown instanceof IllegalStateException, "old reservation initial enqueue still reports its failure");
            assertInitialDiscard(host, rejected, replacement);
            check(replacement.retainedForTest()[0] == 1, "replacement reservation remains intact after old job discard");
            host.releaseReservation(replacement); replacement.discardBeforeStart();
            check(host.active == null && Arrays.equals(replacement.retainedForTest(), new long[] {0, 0, 0, 0, 0, 0}), "explicit test cleanup releases only replacement identity");
        });
        test("initial-enqueue-cancel-before-owner-delivery", () -> {
            FakeHost host = host(); WorkspaceRestoreJob value = prepareInitialJob(host); value.enqueueInitial(); value.cancel(); host.finish("cancelled");
            check(host.beginCalls == 0 && host.created == 0, "cancelled queued start never enters source protocol");
        });
    }

    private static void successfulOwnership() throws Exception {
        test("success-captured-source-target-transfer", () -> {
            FakeHost host = host(); host.pendingAdmissions = 2; host.start(); host.finish("success");
            check(host.sourceReleasedAtPublish, "source released before publication");
            check(host.workerStoppedAtPublish, "target worker stopped before ownership transfer");
            check(host.reservationGoneAtObserver, "busy and global budget released before observer");
            check(host.freed.contains(host.original), "retired source freed");
            check(host.sourceFinishCount == 1, "source finish exactly once");
            check(host.reads == 6 && host.writes == 6 && host.bytesWritten == host.length * 48L, "six exact owned column copies");
            check(host.metrics.copiedBytes == host.length * 48L && host.metrics.logicalBytes == host.logicalBytes, "completion reports copy and logical reservation counts");
            check(host.events.indexOf("ticket-released") < host.events.indexOf("published"), "source release ordered before publish");
            check(host.events.indexOf("reservation-released") < host.events.indexOf("observer"), "reservation released before observation");
        });
        test("empty-source-no-copy", () -> { FakeHost host = host(); host.length = 0; host.start(); host.finish("success"); check(host.reads == 0 && host.writes == 0, "empty source allocates no copy chunk"); });
        test("bounded-multiple-copy-chunks", () -> {
            FakeHost host = host(); host.length = 262145; host.start(); host.finish("success");
            check(host.reads == 12 && host.writes == 12, "six columns use bounded full plus tail chunks");
            check(host.bytesWritten == host.length * 48L, "all bytes copied exactly once");
        });
    }

    private static void phaseFailures() throws Exception {
        String[] stages = {"begin", "admission", "copy-read", "copy-write", "compute", "target-finish", "source-finish"};
        String[] modes = {"throw", "cancel", "stale", "closed"};
        for (String stage : stages) for (String mode : modes) {
            test(mode + "-during-" + stage, () -> {
                FakeHost host = host(); inject(host, stage, mode); host.start();
                host.finish("throw".equals(mode) ? "failed" : "cancel".equals(mode) ? "cancelled" : mode);
                check(host.hookUsed, "injected stage was reached");
            });
        }
        for (String stage : new String[] {"target-create", "compute-start", "source-check"}) {
            test("throw-during-" + stage, () -> {
                FakeHost host = host(); inject(host, stage, "throw"); host.start(); host.finish("failed");
                check(host.hookUsed, "injected failure was reached");
            });
        }
        for (String mode : new String[] {"cancel", "stale", "closed"}) {
            test(mode + "-during-queued-handoff", () -> {
                FakeHost host = host(); host.holdHandoff = true; host.start(); queuedHandoff(host);
                if ("cancel".equals(mode)) host.job.cancel();
                else if ("stale".equals(mode)) host.changeRevision(); else host.closeSource();
                host.finish("cancel".equals(mode) ? "cancelled" : mode);
            });
        }
        test("throw-during-final-publish-compare-swap", () -> {
            FakeHost host = host(); host.rejectPublish = true; host.start(); host.finish("failed");
            check(host.handle == host.original && !host.freed.contains(host.original), "rejected publication preserves live source");
        });
        for (String stage : new String[] {"admission", "copy-read", "compute", "source-finish"}) {
            test("replacement-source-during-" + stage, () -> {
                FakeHost host = host(); host.hookStage = stage; host.hook = () -> host.queue.runOnOwner(host::replaceSource);
                host.start(); host.finish("stale");
                check(host.handle == host.original + 20000, "replacement source preserved");
            });
        }
        test("replacement-source-before-queued-handoff", () -> {
            FakeHost host = host(); host.holdHandoff = true; host.start(); queuedHandoff(host); host.replaceSource(); host.finish("stale");
            check(host.handle == host.original + 20000, "late cleanup leaves replacement handle alone");
        });
        test("source-release-throws-after-release", () -> {
            FakeHost host = host(); host.releaseAfterFailures = 1; awaitPendingSourceRelease(host);
            check(host.ticket == 0 && host.effectiveSourceReleases == 1, "ambiguous throw after disposal is not treated as confirmed cleanup");
            host.job.resumeOwnerCleanup(); host.finish("failed"); host.job.resumeOwnerCleanup();
            check(host.sourceReleaseCalls == 2 && host.effectiveSourceReleases == 1, "explicit idempotent retry confirms disposal without releasing twice");
        });
        test("short-source-copy-rejected", () -> { FakeHost host = host(); host.shortRead = true; host.start(); host.finish("failed"); check(host.writes == 0, "malformed chunk never reaches target"); });
        test("mismatched-admission-ticket-rejected", () -> { FakeHost host = host(); host.mismatchedDescriptor = true; host.start(); host.finish("failed"); check(host.created == 0, "no target allocated for foreign ticket"); });
    }

    private static void cancellationAndCallbacks() throws Exception {
        test("cancel-before-start", () -> {
            FakeHost host = host(); host.job = new WorkspaceRestoreJob(host, "workspace", "binding", 10000, 17); host.active = host.job;
            host.job.cancel(); host.job.start(); host.finish("cancelled"); check(host.created == 0, "cancel before admission allocates no target");
        });
        test("cancel-idempotent-and-late-cancel", () -> {
            FakeHost host = host(); host.start(); host.job.cancel(); host.job.cancel(); host.finish("cancelled");
            host.job.cancel(); host.job.closeOnOwner(); host.job.start(); host.queue.drain();
            check(host.completeCount == 1, "late public entrypoints are no-ops");
        });
        test("cancel-after-commit-preserves-success", () -> {
            FakeHost host = host(); host.observer = () -> { host.job.cancel(); host.job.closeOnOwner(); };
            host.start(); host.finish("success"); check(host.observerCount == 1, "observer ran once after commit");
        });
        test("concurrent-cancel-linearizes-after-commit", () -> {
            FakeHost host = host(); host.publishEntered = new CountDownLatch(1); host.cancelAttempted = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
            host.start();
            Thread cancel = new Thread(() -> { try { await(host.publishEntered, "atomic publish"); host.cancelAttempted.countDown(); host.job.cancel(); } catch (Throwable error) { failure.set(error); } }, "test concurrent cancel");
            cancel.start(); host.finish("success"); cancel.join(WAIT_MILLIS);
            check(!cancel.isAlive() && failure.get() == null, "concurrent cancel exits without changing committed ownership");
        });
        test("callback-errors-after-commit-preserve-success", () -> {
            FakeHost host = host(); host.throwObserver = true; host.throwComplete = true; host.throwDiagnostics = true; host.throwRetiredFree = true;
            host.start(); host.finish("success");
            check(host.terminalError == null, "postcommit callback error is not a job failure");
            check(host.errorCallbackCount == 3, "retirement, observer and completion errors diagnosed");
            check(host.metrics.callbackErrors == 2, "completion metrics include errors known before completion callback");
        });
        test("progress-errors-are-contained", () -> {
            FakeHost host = host(); host.throwProgress = true; host.throwDiagnostics = true; host.start(); host.finish("success");
            check(host.progressCount > 0 && host.errorCallbackCount == host.progressCount, "progress errors are routed to guarded diagnostics");
            check(host.metrics.callbackErrors > 0 && host.metrics.callbackErrors <= 32, "callback count is bounded");
        });
        test("observer-starts-new-job-after-budget-release", () -> {
            OwnerQueue queue = new OwnerQueue(); FakeHost host = new FakeHost(queue, 201); FakeHost next = new FakeHost(queue, 202);
            host.logicalBytes = WorkspaceRestoreJob.MAX_BYTES; next.logicalBytes = WorkspaceRestoreJob.MAX_BYTES;
            host.observer = () -> { check(host.active == null, "busy released before reentry"); check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {0, 0}), "budget released before reentry"); next.start(); };
            host.start(); host.finish("success"); next.finish("success");
            check(next.created == 1, "reentrant job can reserve entire global byte budget");
        });
        test("completion-starts-new-job-after-budget-release", () -> {
            OwnerQueue queue = new OwnerQueue(); FakeHost host = new FakeHost(queue, 301); FakeHost next = new FakeHost(queue, 302);
            host.completion = next::start; host.start(); host.finish("success"); next.finish("success");
            check(next.publicationCount == 1, "completion reentry owns its separate target");
        });
        test("duplicate-and-late-handoff-callbacks", () -> {
            FakeHost host = host(); host.holdHandoff = true; host.start(); queuedHandoff(host);
            List<Runnable> ready = new ArrayList<Runnable>(host.queue.tasks);
            host.finish("success"); for (Runnable callback : ready) { callback.run(); callback.run(); }
            host.queue.drain();
            check(host.completeCount == 1 && host.publicationCount == 1, "duplicate handoff and late progress cannot complete or publish twice");
            check(host.violations.isEmpty(), "late callbacks do not touch freed source or live target");
        });
        test("duplicate-admission-callback-does-not-launch-second-worker", () -> {
            FakeHost host = host(); host.start(); Runnable admission = host.queue.tasks.peek();
            host.queue.tick(); admission.run(); host.finish("success");
            check(host.created == 1, "duplicate admission schedules only one target worker");
        });
        test("duplicate-incomplete-admission-callbacks", () -> {
            FakeHost host = host(); host.pendingAdmissions = 2; host.start(); Runnable admission = host.queue.tasks.peek();
            host.queue.tick(); admission.run(); host.finish("success"); admission.run();
            check(host.created == 1 && host.violations.isEmpty(), "extra pending admission callbacks never start a second worker");
        });
        test("duplicate-start-does-not-reserve-twice", () -> {
            FakeHost host = host(); host.start(); host.job.start(); host.finish("success");
            check(host.created == 1, "duplicate start schedules one admission and target");
        });
        test("late-owner-copy-after-cancel", () -> {
            FakeHost host = host(); host.start();
            host.queue.until(() -> host.worker != null && !host.queue.tasks.isEmpty());
            List<Runnable> ready = new ArrayList<Runnable>(host.queue.tasks);
            host.job.cancel(); host.finish("cancelled"); for (Runnable callback : ready) callback.run();
            check(host.completeCount == 1 && host.violations.isEmpty(), "late owner-copy task is guarded before source access");
        });
    }

    private static void budgetsAndQueueFailures() throws Exception {
        test("two-jobs-allowed-third-rejected", () -> {
            OwnerQueue queue = new OwnerQueue(); FakeHost a = new FakeHost(queue, 401), b = new FakeHost(queue, 402), c = new FakeHost(queue, 403);
            a.start(); b.start(); c.start(); check(WorkspaceRestoreJob.budgetForTest()[0] == 2, "two admitted global slots remain");
            c.finish("failed"); a.finish("success"); b.finish("success"); check(c.created == 0, "third job never allocates a target");
        });
        test("concurrent-logical-byte-budget-rejects-overflow", () -> {
            OwnerQueue queue = new OwnerQueue(); FakeHost a = new FakeHost(queue, 501), b = new FakeHost(queue, 502);
            a.logicalBytes = WorkspaceRestoreJob.MAX_BYTES; b.logicalBytes = 1;
            a.start(); b.start(); b.finish("failed"); a.finish("success"); check(b.created == 0, "overbudget target is never allocated");
        });
        test("concurrent-logical-byte-budget-exact-fit", () -> {
            OwnerQueue queue = new OwnerQueue(); FakeHost a = new FakeHost(queue, 601), b = new FakeHost(queue, 602);
            a.logicalBytes = WorkspaceRestoreJob.MAX_BYTES / 2; b.logicalBytes = WorkspaceRestoreJob.MAX_BYTES / 2;
            a.start(); b.start(); a.finish("success"); b.finish("success"); check(a.created + b.created == 2, "exact combined byte limit admits both targets");
        });
        test("simultaneous-owner-byte-reservations", () -> {
            CountDownLatch atAdmission = new CountDownLatch(2), releaseAdmission = new CountDownLatch(1);
            CountDownLatch attempted = new CountDownLatch(2), releaseWorkers = new CountDownLatch(1);
            AtomicReference<Throwable> failure = new AtomicReference<Throwable>();
            FakeHost[] hosts = new FakeHost[2]; Thread[] owners = new Thread[2];
            for (int i = 0; i < owners.length; i++) {
                final int index = i;
                owners[i] = new Thread(() -> {
                    try {
                        FakeHost value = new FakeHost(new OwnerQueue(), 701 + index); hosts[index] = value;
                        value.logicalBytes = WorkspaceRestoreJob.MAX_BYTES;
                        value.hookStage = "admission"; value.hook = () -> {
                            atAdmission.countDown(); await(releaseAdmission, "simultaneous admission release");
                            value.hookStage = "target-create"; value.hookUsed = false;
                            value.hook = () -> await(releaseWorkers, "budget winner worker release");
                        };
                        value.start(); value.queue.until(() -> value.worker != null || value.completeCount > 0);
                        attempted.countDown(); await(releaseWorkers, "owner reservation inspection");
                        value.queue.until(() -> value.completeCount > 0);
                        if (value.worker != null) value.worker.join(WAIT_MILLIS);
                        value.queue.drain();
                    } catch (Throwable error) { failure.compareAndSet(null, error); attempted.countDown(); }
                }, "test separate owner " + i);
                owners[i].start();
            }
            await(atAdmission, "both independent owner threads at admission"); releaseAdmission.countDown();
            await(attempted, "both byte reservation attempts");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, WorkspaceRestoreJob.MAX_BYTES}), "atomic global budget admits only one concurrent full-size job");
            releaseWorkers.countDown(); for (Thread owner : owners) owner.join(WAIT_MILLIS);
            check(!owners[0].isAlive() && !owners[1].isAlive() && failure.get() == null, "independent owner threads terminate cleanly: " + failure.get());
            int successes = 0, failures = 0;
            for (FakeHost value : hosts) {
                if ("success".equals(value.status)) successes++; if ("failed".equals(value.status)) failures++;
                check(value.completeCount == 1 && value.violations.isEmpty(), "concurrent ownership invariants and once completion");
                check(Arrays.equals(value.job.retainedForTest(), new long[] {0, 0, 0, 0, 0, 0}), "concurrent terminal releases references");
            }
            check(successes == 1 && failures == 1, "exactly one concurrent reservation wins");
        });
        test("admission-post-false-owner-can-clean", () -> {
            FakeHost host = host(); host.queue.rejectNext.set(1); host.start(); host.finish("failed"); check(host.created == 0, "failed admission scheduling allocates no target");
        });
        test("copy-request-post-false-cleanup-post-accepted", () -> {
            FakeHost host = host(); host.hookStage = "target-create"; host.hook = () -> host.queue.rejectNext.set(1);
            host.start(); host.finish("failed"); check(host.reads == 0, "rejected owner request performs no source read");
        });
        test("handoff-post-false-cleanup-post-accepted", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> host.queue.rejectNext.set(1);
            host.start(); host.finish("failed"); check(host.sourceFinishCount == 0, "rejected handoff does not finish source");
        });
        test("cancel-post-false-existing-admission-delivers-stop", () -> {
            FakeHost host = host(); host.start(); host.queue.rejectNext.set(1); host.job.cancel(); host.finish("cancelled");
            check(host.created == 0, "existing owner task observes monotonic cancellation");
        });
        test("handoff-waits-for-real-worker-exit", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> {
                host.queue.handoffWorker = Thread.currentThread(); host.queue.handoffPostEntered = new CountDownLatch(1);
                host.queue.handoffPostResume = new CountDownLatch(1); host.queue.captureNextWorkerPost = true;
            };
            host.start(); host.queue.until(() -> host.queue.handoffPostEntered != null && host.queue.handoffPostEntered.getCount() == 0);
            host.queue.until(() -> host.queue.delayedPosts.get() > 0); check(host.publicationCount == 0, "handoff cannot publish while worker remains in accepted post");
            host.queue.handoffPostResume.countDown(); host.finish("success");
            check(host.workerStoppedAtPublish, "delayed handoff waits for actual thread termination");
        });
        test("delayed-handoff-post-false-owner-can-clean", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> {
                host.queue.rejectDelayed = true; host.queue.handoffWorker = Thread.currentThread();
                host.queue.handoffPostEntered = new CountDownLatch(1); host.queue.handoffPostResume = new CountDownLatch(1); host.queue.captureNextWorkerPost = true;
            };
            host.start(); host.queue.until(() -> host.queue.handoffPostEntered != null && host.queue.handoffPostEntered.getCount() == 0);
            host.queue.until(() -> host.queue.delayedPosts.get() > 0); host.queue.handoffPostResume.countDown(); host.finish("failed");
            check(host.sourceFinishCount == 0, "failed delayed handoff leaves source unpublished");
        });
    }

    private static void throwingQueueBoundaries() throws Exception {
        test("initial-admission-post-throws-owner-cleans", () -> {
            FakeHost host = host(); host.queue.throwNext.set(1); host.start(); host.finish("failed");
            check(host.created == 0 && host.terminalError instanceof AssertionError, "enqueue Error is recorded without allocating target");
        });
        test("continued-admission-post-throws-owner-cleans", () -> {
            FakeHost host = host(); host.pendingAdmissions = 1; host.hookStage = "admission"; host.hook = () -> host.queue.throwNext.set(1);
            host.start(); host.finish("failed"); check(host.created == 0 && host.hookUsed, "admission continuation throwable releases source and reservation");
        });
        test("copy-request-post-throws-worker-cleans", () -> {
            FakeHost host = host(); host.hookStage = "target-create"; host.hook = () -> host.queue.throwNext.set(1);
            host.start(); host.finish("failed"); check(host.reads == 0 && host.freed.contains(host.target), "throwing copy enqueue frees worker-owned target");
        });
        test("handoff-post-throws-worker-cleans", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> host.queue.throwNext.set(1);
            host.start(); host.finish("failed"); check(host.sourceFinishCount == 0 && host.freed.contains(host.target), "throwing handoff enqueue never transfers target");
        });
        test("cancel-post-throws-existing-admission-cleans", () -> {
            FakeHost host = host(); host.start(); host.queue.throwNext.set(1); host.job.cancel(); host.finish("cancelled");
            check(host.created == 0 && host.terminalError instanceof AssertionError, "cancel remains monotonic while recording enqueue Error");
        });
        test("cancel-before-start-post-throws-owner-recovers", () -> {
            FakeHost host = host(); host.job = new WorkspaceRestoreJob(host, "workspace", "binding", 10000, 17); host.active = host.job;
            host.queue.throwNext.set(1); host.job.cancel();
            check(host.job.pendingOwnerCleanup() && host.completeCount == 0, "cancel without an owner task exposes pending cleanup");
            host.job.resumeOwnerCleanup(); host.finish("cancelled");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {0, 0}), "pre-start recovery invents no reservation");
        });
        test("worker-final-cleanup-post-throws-owner-recovers", () -> {
            FakeHost host = host(); host.hookStage = "compute"; host.hook = () -> {
                host.queue.throwNext.set(1); throw new IllegalStateException("injected compute failure before cleanup enqueue");
            };
            host.start(); host.queue.until(() -> host.worker != null && !host.worker.isAlive());
            host.worker.join(WAIT_MILLIS);
            check(host.job.pendingOwnerCleanup() && "failed".equals(host.job.pendingOwnerFailure()), "throwing final cleanup enqueue exposes pending failure");
            check(host.completeCount == 0 && host.freed.contains(host.target) && host.ticket == host.expectedTicket, "worker target is reclaimed while owner source release waits");
            check(Arrays.equals(host.job.retainedForTest(), new long[] {1, 0, 0, 0, 0, 0}), "throwing cleanup enqueue drops all large temporary references");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, host.logicalBytes}), "pending source keeps its budget reservation");
            host.job.resumeOwnerCleanup(); host.finish("failed");
        });
        test("delayed-handoff-post-throws-owner-cleans", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> {
                host.queue.throwDelayed = true; host.queue.handoffWorker = Thread.currentThread();
                host.queue.handoffPostEntered = new CountDownLatch(1); host.queue.handoffPostResume = new CountDownLatch(1); host.queue.captureNextWorkerPost = true;
            };
            host.start(); host.queue.until(() -> host.queue.handoffPostEntered != null && host.queue.handoffPostEntered.getCount() == 0);
            host.queue.until(() -> host.queue.delayedPosts.get() > 0); host.queue.handoffPostResume.countDown(); host.finish("failed");
            check(host.sourceFinishCount == 0 && host.terminalError instanceof AssertionError, "delayed enqueue Error does not leak or publish pending target");
        });
    }

    private static void awaitComputeWithOwnerPaused(FakeHost host) throws Exception {
        host.length = 0; host.computeSteps = 1000; host.holdHandoff = true; host.start();
        host.queue.tick(); // Admission is the only owner delivery before the worker computes.
        await(host.targetFinished, "1000 compute steps while owner is paused");
        host.worker.join(WAIT_MILLIS);
        invariant(!host.worker.isAlive(), "compute-pressure worker stopped before owner resumed");
        invariant(host.queue.held != null, "pressure target has a separately owned queued handoff");
    }

    private static void progressPressure() throws Exception {
        test("progress-coalesces-while-owner-paused", () -> {
            FakeHost host = host(); awaitComputeWithOwnerPaused(host);
            check(host.steps == 1000 && host.queue.tasks.size() == 1, "1000 reports occupy one owner progress callback");
            Runnable lateProgress = host.queue.tasks.peek(); host.queue.tick();
            check("compute".equals(host.lastProgressPhase) && host.lastProgressDone == 1000, "owner receives latest compute progress");
            check(host.progressCount == 2, "only admission and coalesced final progress were observed");
            queuedHandoff(host); host.finish("success"); lateProgress.run(); lateProgress.run();
            check(host.progressCount == 2 && host.completeCount == 1, "stale progress callback after terminal is inert");
        });
        test("progress-post-false-next-report-recovers", () -> {
            FakeHost host = host(); host.hookStage = "compute"; host.hook = () -> host.queue.rejectNext.set(1);
            awaitComputeWithOwnerPaused(host);
            check(host.queue.tasks.size() == 1, "rejected first progress enqueue does not strand later reports");
            host.queue.tick(); check(host.lastProgressDone == 1000, "retry delivers latest progress rather than dropped first value");
            queuedHandoff(host); host.finish("success");
        });
        for (String mode : new String[] {"cancel", "closed", "throw"}) {
            test("progress-callback-reentry-" + mode, () -> {
                FakeHost host = host();
                host.computeProgress = () -> {
                    if ("cancel".equals(mode)) host.job.cancel();
                    else if ("closed".equals(mode)) host.closeSource();
                    else throw new IllegalStateException("compute progress callback");
                };
                awaitComputeWithOwnerPaused(host);
                check(host.queue.tasks.size() == 1, "reentrant progress remains bounded");
                Runnable lateProgress = host.queue.tasks.peek(); host.queue.tick();
                queuedHandoff(host); host.finish("cancel".equals(mode) ? "cancelled" : "closed".equals(mode) ? "closed" : "success");
                int completeProgress = host.progressCount; lateProgress.run();
                check(host.progressCount == completeProgress && host.completeCount == 1, "late reentrant progress cannot run callbacks after terminal");
            });
        }
    }

    private static void beginResponseOwnership() throws Exception {
        test("begin-throws-before-registration-token-abort", () -> {
            FakeHost host = host(); host.registrations.add(host.foreignRegistration); inject(host, "begin", "throw");
            host.start(); host.finish("failed");
            check(host.unknownTicketAbortCalls == 1 && host.effectiveSourceReleases == 0, "unknown-ticket abort is safe when begin had no side effect");
            check(host.registrations.size() == 1 && host.registrations.contains(host.foreignRegistration), "failed begin never aborts an unrelated registration");
        });
        test("begin-response-lost-after-registration-token-abort", () -> {
            FakeHost host = host(); host.beginResponseLost = true; host.registrations.add(host.foreignRegistration);
            host.start(); host.finish("failed");
            check(host.unknownTicketAbortCalls == 1 && host.effectiveSourceReleases == 1, "captured token releases registration despite absent begin result");
            check(host.registrations.size() == 1 && host.registrations.contains(host.foreignRegistration), "response-loss abort preserves a foreign registration");
        });
        for (long returned : new long[] {0, -7, 9007199254740992L}) {
            final long invalid = returned;
            test("begin-invalid-result-token-abort-" + (returned < 0 ? "negative" : returned == 0 ? "zero" : "unsafe"), () -> {
                FakeHost host = host(); host.beginResultOverride = invalid; host.start(); host.finish("failed");
                check(host.unknownTicketAbortCalls == 1 && host.effectiveSourceReleases == 1, "invalid returned ticket is never passed back as an owned ticket");
                check(host.created == 0 && !host.registrations.contains(host.capturedRegistration), "invalid begin response leaves no captured registration or target");
            });
        }
        test("begin-abort-response-lost-pending-idempotent-retry", () -> {
            FakeHost host = host(); host.beginResponseLost = true; host.releaseAfterFailures = 1; host.registrations.add(host.foreignRegistration);
            host.start();
            check(host.job.pendingOwnerCleanup() && host.completeCount == 0 && host.unknownTicketAbortCalls == 1, "ambiguous token-abort response remains pending");
            check(host.ticket == 0 && host.effectiveSourceReleases == 1, "first abort actually removed captured registration");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, 0}), "unknown admission outcome retains its slot without inventing admitted bytes");
            check(Arrays.equals(host.job.retainedForTest(), new long[] {1, 0, 0, 0, 0, 0}), "pending token abort retains only minimum owner context");
            host.job.resumeOwnerCleanup(); host.finish("failed"); host.job.resumeOwnerCleanup();
            check(host.unknownTicketAbortCalls == 2 && host.effectiveSourceReleases == 1, "retry is token-bound and idempotent");
            check(host.registrations.size() == 1 && host.registrations.contains(host.foreignRegistration), "repeated token abort cannot remove unrelated registration");
        });
        test("begin-abort-before-side-effect-pending-retry", () -> {
            FakeHost host = host(); host.beginResponseLost = true; host.releaseBeforeFailures = 1; host.start();
            check(host.job.pendingOwnerCleanup() && host.ticket == host.expectedTicket, "failed token abort keeps genuinely retained source registration");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, 0}), "pending pre-admission source registration keeps global slot");
            host.job.resumeOwnerCleanup(); host.finish("failed");
            check(host.unknownTicketAbortCalls == 2 && host.effectiveSourceReleases == 1, "retry cleans captured registration after pre-side-effect failure");
        });
    }

    private static void awaitPendingSourceRelease(FakeHost host) throws Exception {
        host.hookStage = "compute"; host.hook = () -> { throw new IllegalStateException("compute fails before source cleanup"); };
        host.start(); host.queue.until(() -> host.job.pendingOwnerCleanup());
        if (host.worker != null) host.worker.join(WAIT_MILLIS);
        check(host.completeCount == 0 && host.sourceReleaseCalls == 1, "source disposal exception defers completion without implicit retry");
        check(host.freed.contains(host.target), "source disposal failure cannot retain untransferred target");
        check(host.reservationReleases == 0 && host.active == host.job, "uncertain source disposal keeps engine busy");
        check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, host.logicalBytes}), "uncertain source disposal retains slot and byte reservation");
        check(Arrays.equals(host.job.retainedForTest(), new long[] {1, 0, 0, 0, 0, 0}), "source retry retains minimal host context only");
    }

    private static void sourceReleaseRecovery() throws Exception {
        test("source-release-throws-before-side-effect", () -> {
            FakeHost host = host(); host.releaseBeforeFailures = 1; awaitPendingSourceRelease(host);
            check(host.ticket == host.expectedTicket && host.effectiveSourceReleases == 0, "failed pre-disposal call leaves source lease genuinely owned");
            host.job.resumeOwnerCleanup(); host.finish("failed");
            check(host.sourceReleaseCalls == 2 && host.effectiveSourceReleases == 1, "explicit recovery disposes original ticket exactly once");
        });
        test("source-release-needs-two-owner-recoveries", () -> {
            FakeHost host = host(); host.releaseBeforeFailures = 2; awaitPendingSourceRelease(host);
            host.job.resumeOwnerCleanup();
            check(host.job.pendingOwnerCleanup() && host.completeCount == 0 && host.sourceReleaseCalls == 2, "failed first recovery remains pending");
            check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, host.logicalBytes}), "repeated release failure keeps admission budget");
            host.job.resumeOwnerCleanup(); host.finish("failed");
            check(host.sourceReleaseCalls == 3 && host.effectiveSourceReleases == 1, "second explicit recovery finishes single source release");
        });
        test("source-release-recovery-close-reentry", () -> {
            FakeHost host = host(); host.releaseBeforeFailures = 1; awaitPendingSourceRelease(host);
            host.hookStage = "source-release"; host.hookUsed = false; host.hook = host::closeSource;
            host.job.resumeOwnerCleanup(); host.finish("failed");
            check(host.sourceReleaseCalls == 2 && host.hookUsed, "close reentry during recovery cannot recursively dispose ticket");
            check(host.handle == 0 && host.live.isEmpty(), "close reentry leaves no native handle owned");
        });
        test("source-release-recovery-skips-freed-source-handle", () -> {
            FakeHost host = host(); host.releaseBeforeFailures = 1; awaitPendingSourceRelease(host);
            host.replaceSource(); host.job.resumeOwnerCleanup(); host.finish("failed");
            check(host.sourceReleaseCalls == 1, "recovery never invokes disposal on already freed original source");
            check(host.handle == host.original + 20000 && host.live.contains(host.handle), "old ticket is never applied to replacement engine handle");
        });
        test("source-release-owner-close-after-failure", () -> {
            FakeHost host = host(); host.releaseBeforeFailures = 1; awaitPendingSourceRelease(host);
            host.job.closeOnOwner(); host.finish("failed");
            check(host.sourceReleaseCalls == 2 && host.effectiveSourceReleases == 1, "explicit owner close retries captured source disposal");
        });
    }

    private static void ownerRecovery() throws Exception {
        for (String stage : new String[] {"target-create", "target-finish"}) {
            test("owner-queue-recovery-after-" + stage, () -> {
                FakeHost host = host(); host.hookStage = stage; host.hook = () -> { host.queue.unavailable = true; };
                host.start();
                host.queue.until(() -> host.worker != null && host.queue.unavailable);
                host.worker.join(WAIT_MILLIS);
                check(!host.worker.isAlive() && host.job.pendingOwnerCleanup(), "stopped worker exposes pending owner cleanup");
                check(host.completeCount == 0 && host.ticket == host.expectedTicket, "owner-only release is deferred honestly");
                check(Arrays.equals(host.job.retainedForTest(), new long[] {1, 0, 0, 0, 0, 0}), "pending cleanup retains only minimal host context");
                check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, host.logicalBytes}), "pending source still owns global admission and byte reservation");
                check(host.active == host.job, "same engine busy reservation blocks premature reentry");
                host.queue.unavailable = false; host.job.resumeOwnerCleanup(); host.finish("failed");
                host.job.resumeOwnerCleanup();
                check(!host.job.pendingOwnerCleanup() && host.completeCount == 1, "owner recovery is terminal and idempotent");
            });
        }
        test("owner-close-recovers-pending-cleanup", () -> {
            FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> { host.queue.unavailable = true; };
            host.start(); host.queue.until(() -> host.targetFinished.getCount() == 0); host.worker.join(WAIT_MILLIS);
            check(host.job.pendingOwnerCleanup(), "owner cleanup is pending before close");
            host.closeSource(); host.finish("failed");
            check(!host.job.pendingOwnerCleanup(), "close resolves pending owner cleanup");
        });
        test("cancelled-owner-queue-recovery", () -> {
            FakeHost host = host(); host.hookStage = "compute"; host.hook = () -> { host.queue.unavailable = true; host.job.cancel(); };
            host.start(); host.queue.until(() -> host.worker != null && host.queue.unavailable); host.worker.join(WAIT_MILLIS);
            check(host.job.pendingOwnerCleanup(), "cancelled job records rejected cleanup post");
            host.queue.unavailable = false; host.job.resumeOwnerCleanup(); host.finish("cancelled");
            check(host.publicationCount == 0, "recovery never publishes cancelled target");
        });
    }

    private static void validation() throws Exception {
        test("descriptor-invalid-ranges", () -> {
            long[][] invalid = {{0, 0, 1}, {9007199254740992L, 0, 1}, {1, -1, 1}, {1, 4194305, 1}, {1, 0, 0}, {1, 0, WorkspaceRestoreJob.MAX_BYTES + 1}};
            for (long[] input : invalid) {
                boolean rejected = false;
                try { new WorkspaceRestoreJob.Descriptor(input[0], "metadata", (int) input[1], input[2]); }
                catch (IllegalArgumentException expected) { rejected = true; }
                check(rejected, "descriptor range rejected: " + Arrays.toString(input));
            }
        });
        test("constructor-invalid-ranges", () -> {
            FakeHost host = host();
            long[][] invalid = {{0, 1}, {600001, 1}, {1000, 0}, {1000, 16385}};
            for (long[] input : invalid) {
                boolean rejected = false;
                try { new WorkspaceRestoreJob(host, "workspace", "binding", input[0], (int) input[1]); }
                catch (IllegalArgumentException expected) { rejected = true; }
                check(rejected, "constructor range rejected: " + Arrays.toString(input));
            }
        });
        test("deadline-before-admission", () -> {
            FakeHost host = host(); host.job = new WorkspaceRestoreJob(host, "workspace", "binding", 1, 17); host.active = host.job;
            Thread.sleep(5); host.job.start(); host.finish("timedOut"); check(host.created == 0, "expired job allocates no target");
        });
    }

    private static void unavailableOwnerBoundary() throws Exception {
        scenario = "permanently-unavailable-owner-boundary";
        FakeHost host = host(); host.hookStage = "target-finish"; host.hook = () -> { host.queue.unavailable = true; };
        host.start(); host.queue.until(() -> host.targetFinished.getCount() == 0);
        host.worker.join(WAIT_MILLIS);
        check(!host.worker.isAlive(), "worker still stops without owner delivery");
        check(host.freed.contains(host.target), "untransferred target reclaimed by worker");
        check(host.completeCount == 0, "no terminal owner completion is fabricated");
        check(host.ticket == host.expectedTicket, "source ownership remains pending owner cleanup");
        check(Arrays.equals(WorkspaceRestoreJob.budgetForTest(), new long[] {1, host.logicalBytes}), "global reservation remains pending owner cleanup");
        check(Arrays.equals(host.job.retainedForTest(), new long[] {1, 0, 0, 0, 0, 0}), "job retains only minimal owner context");
        check(host.job.pendingOwnerCleanup(), "permanent owner loss exposes pending cleanup");
        check(host.handle == host.original && host.live.contains(host.original), "live source is not unsafely freed by worker");
        check(host.violations.isEmpty(), "worker never impersonates unavailable owner");
        System.out.println("UNAVAILABLE_OWNER scenarios=1 checks=" + checks + " terminal=false sourceRelease=false budgetRelease=false targetFreed=true");
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 1 && "--unavailable-owner".equals(args[0])) { unavailableOwnerBoundary(); return; }
        if (args.length != 0) throw new IllegalArgumentException("Unexpected harness arguments");
        initialEnqueueOwnership(); successfulOwnership(); phaseFailures(); cancellationAndCallbacks(); budgetsAndQueueFailures(); throwingQueueBoundaries(); progressPressure(); beginResponseOwnership(); sourceReleaseRecovery(); ownerRecovery(); validation();
        System.out.println("RESULT scenarios=" + scenarios + " checks=" + checks + " owner=main worker=real-thread");
    }
}
