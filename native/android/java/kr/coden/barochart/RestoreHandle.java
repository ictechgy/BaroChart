package kr.coden.barochart;

/** Handle for a running {@code restoreWorkspace}. */
public final class RestoreHandle {
    private final BaroChartEngine.WorkspaceJob job;

    RestoreHandle(BaroChartEngine.WorkspaceJob job) { this.job = job; }

    /** Requests cancellation. The callback then reports {@code CANCELLED} unless the restore already finished. Safe on any thread. */
    public void cancel() { job.cancel(); }
}
