package android.os;

import java.util.ArrayList;
import java.util.List;

/** Test-only bounded owner queue. Posted work never runs inline. */
public final class Handler {
    private static final int MAX_PENDING=16;
    private static final List<Runnable> QUEUE=new ArrayList<Runnable>();
    public Handler(Looper looper){if(looper==null)throw new IllegalArgumentException("Looper required");}
    public boolean post(Runnable task){if(QUEUE.size()>=MAX_PENDING)return false;QUEUE.add(task);return true;}
    public boolean postDelayed(Runnable task,long delayMillis){return post(task);}
    public void removeCallbacksAndMessages(Object token){QUEUE.clear();}
    public static void clearFixtureQueue(){QUEUE.clear();}
}
