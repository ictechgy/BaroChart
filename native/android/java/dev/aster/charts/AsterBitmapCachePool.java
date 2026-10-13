package dev.aster.charts;

import android.content.*;
import android.content.res.Configuration;
import android.os.Looper;
import org.json.*;
import java.lang.ref.WeakReference;
import java.util.*;

/** Main-thread accounting of CPU bitmap allocation bytes; no Activity or View is retained. */
final class AsterBitmapCachePool implements ComponentCallbacks2 {
    static final AsterBitmapCachePool INSTANCE=new AsterBitmapCachePool();
    static final long DEFAULT_BUDGET=64L*1024*1024;
    private final ArrayList<Entry> entries=new ArrayList<>();
    private long budget=DEFAULT_BUDGET,used=0,clock=0,generation=0,ownershipGeneration=0,evictions=0,denials=0,trims=0;
    private boolean registered=false;
    private static final class Entry {final WeakReference<AsterChartView> view;long bytes,touched;Entry(AsterChartView view){this.view=new WeakReference<>(view);}}
    private static void owner(){if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Bitmap pool requires main thread");}
    void register(Context context){owner();if(!registered){context.getApplicationContext().registerComponentCallbacks(this);registered=true;}}
    private void prune(){for(Iterator<Entry> it=entries.iterator();it.hasNext();){Entry entry=it.next();if(entry.view.get()==null){used-=entry.bytes;it.remove();ownershipGeneration++;}}}
    private Entry find(AsterChartView view){for(Entry entry:entries)if(entry.view.get()==view)return entry;return null;}
    // Only explicit budget/pressure changes permit retry before a View's cooldown.
    // Admission, LRU eviction, detach and collection must not wake competing caches.
    long generation(){owner();return generation;}
    void touch(AsterChartView view){owner();Entry entry=find(view);if(entry!=null)entry.touched=++clock;}
    boolean reserve(AsterChartView view,long desired){owner();prune();if(desired<0||desired>budget){denials++;return false;}Entry own=find(view);long existing=own==null?0:own.bytes;
        while(used-existing+desired>budget){Entry victim=null;for(Entry entry:entries)if(entry.view.get()!=view&&entry.bytes>0&&(victim==null||entry.touched<victim.touched))victim=entry;if(victim==null){denials++;return false;}AsterChartView evicted=victim.view.get();if(evicted==null){prune();continue;}evictions++;evicted.evictBitmapCache();}
        if(own==null){own=new Entry(view);entries.add(own);ownershipGeneration++;}else if(own.bytes!=desired)ownershipGeneration++;used+=desired-own.bytes;own.bytes=desired;own.touched=++clock;return true;
    }
    void release(AsterChartView view){owner();Entry entry=find(view);if(entry!=null){used-=entry.bytes;entries.remove(entry);ownershipGeneration++;}}
    void setBudget(long bytes){owner();if(bytes<0||bytes>256L*1024*1024)throw new IllegalArgumentException("Bitmap budget0..256MiB");budget=bytes;generation++;prune();while(used>budget){Entry victim=null;for(Entry entry:entries)if(entry.bytes>0&&(victim==null||entry.touched<victim.touched))victim=entry;if(victim==null)break;AsterChartView view=victim.view.get();if(view==null){prune();continue;}evictions++;view.evictBitmapCache();}}
    JSONObject metrics() throws JSONException {owner();prune();return new JSONObject().put("budgetBytes",budget).put("ownedBitmapBytes",used).put("liveEntries",entries.size()).put("evictions",evictions).put("denials",denials).put("memoryTrims",trims).put("generation",generation).put("ownershipGeneration",ownershipGeneration).put("scope","CPU Bitmap allocationByteCount owned by live caches; not RSS/PSS or RenderThread/GPU retained copies");}
    private void trim(){owner();trims++;generation++;for(Entry entry:new ArrayList<>(entries)){AsterChartView view=entry.view.get();if(view!=null)view.evictBitmapCache();}prune();}
    @Override public void onLowMemory(){trim();}
    @Override public void onTrimMemory(int level){if(level>=TRIM_MEMORY_RUNNING_LOW)trim();}
    @Override public void onConfigurationChanged(Configuration configuration){}
}
