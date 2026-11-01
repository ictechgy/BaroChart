package kr.coden.barochart;

import android.content.*;
import android.content.res.Configuration;
import android.os.Looper;
import org.json.*;
import java.lang.ref.WeakReference;
import java.util.*;

/** Main-thread accounting of CPU bitmap allocation bytes; no Activity or View is retained. */
final class BaroChartBitmapCachePool implements ComponentCallbacks2 {
    static final BaroChartBitmapCachePool INSTANCE=new BaroChartBitmapCachePool();
    static final long DEFAULT_BUDGET=64L*1024*1024;
    private final ArrayList<Entry> entries=new ArrayList<>();
    private long budget=DEFAULT_BUDGET,used=0,clock=0,generation=0,ownershipGeneration=0,evictions=0,denials=0,trims=0;
    private boolean registered=false;
    private static final class Entry {final WeakReference<BaroChartView> view;long bytes,touched;Entry(BaroChartView view){this.view=new WeakReference<>(view);}}
    private static void owner(){if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Bitmap pool requires main thread");}
    void register(Context context){owner();if(!registered){context.getApplicationContext().registerComponentCallbacks(this);registered=true;}}
    private void prune(){for(Iterator<Entry> it=entries.iterator();it.hasNext();){Entry entry=it.next();if(entry.view.get()==null){used-=entry.bytes;it.remove();ownershipGeneration++;}}}
    private Entry find(BaroChartView view){for(Entry entry:entries)if(entry.view.get()==view)return entry;return null;}
    // Only explicit budget/pressure changes permit retry before a View's cooldown.
    // Admission, LRU eviction, detach and collection must not wake competing caches.
    long generation(){owner();return generation;}
    void touch(BaroChartView view){owner();Entry entry=find(view);if(entry!=null)entry.touched=++clock;}
    boolean reserve(BaroChartView view,long desired){owner();prune();if(desired<0||desired>budget){denials++;return false;}Entry own=find(view);long existing=own==null?0:own.bytes;
        while(used-existing+desired>budget){Entry victim=null;for(Entry entry:entries)if(entry.view.get()!=view&&entry.bytes>0&&(victim==null||entry.touched<victim.touched))victim=entry;if(victim==null){denials++;return false;}BaroChartView evicted=victim.view.get();if(evicted==null){prune();continue;}evictions++;evicted.evictBitmapCache();}
        if(own==null){own=new Entry(view);entries.add(own);ownershipGeneration++;}else if(own.bytes!=desired)ownershipGeneration++;used+=desired-own.bytes;own.bytes=desired;own.touched=++clock;return true;
    }
    void release(BaroChartView view){owner();Entry entry=find(view);if(entry!=null){used-=entry.bytes;entries.remove(entry);ownershipGeneration++;}}
    void setBudget(long bytes){owner();if(bytes<0||bytes>256L*1024*1024)throw new IllegalArgumentException("Bitmap budget0..256MiB");budget=bytes;generation++;prune();while(used>budget){Entry victim=null;for(Entry entry:entries)if(entry.bytes>0&&(victim==null||entry.touched<victim.touched))victim=entry;if(victim==null)break;BaroChartView view=victim.view.get();if(view==null){prune();continue;}evictions++;view.evictBitmapCache();}}
    JSONObject metrics() throws JSONException {owner();prune();return new JSONObject().put("budgetBytes",budget).put("ownedBitmapBytes",used).put("liveEntries",entries.size()).put("evictions",evictions).put("denials",denials).put("memoryTrims",trims).put("generation",generation).put("ownershipGeneration",ownershipGeneration).put("scope","CPU Bitmap allocationByteCount owned by live caches; not RSS/PSS or RenderThread/GPU retained copies");}
    private void trim(){owner();trims++;generation++;for(Entry entry:new ArrayList<>(entries)){BaroChartView view=entry.view.get();if(view!=null)view.evictBitmapCache();}prune();}
    // ComponentCallbacks가 onLowMemory 구현을 강제하고, API 26~33 기기는 아직 이 콜백과
    // TRIM_MEMORY_RUNNING_LOW를 전달한다(minSdk 26). 그래서 메서드 단위로만 deprecation 경고를 억제한다.
    @SuppressWarnings("deprecation") @Override public void onLowMemory(){trim();}
    @SuppressWarnings("deprecation") @Override public void onTrimMemory(int level){if(level>=TRIM_MEMORY_RUNNING_LOW)trim();}
    @Override public void onConfigurationChanged(Configuration configuration){}
}
