package dev.aster.charts;
import android.app.Activity;import android.os.*;import android.view.*;import android.widget.*;import org.json.*;

/** Dedicated local fixture: two independent SDK engines; only A has a View. */
public final class IngestionActivity extends Activity {
    IngestionFeed feed;AsterChartView chart;TextView status;
    private final Window.OnFrameMetricsAvailableListener frames=(window,metrics,dropped)->{if(feed!=null&&feed.probe.measuring){feed.probe.frameTotal.add(metrics.getMetric(FrameMetrics.TOTAL_DURATION)/1e6);feed.probe.frameMetricsDropped+=dropped;}};
    @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);status=new TextView(this);status.setText("Preparing two100k native streams...");content.addView(status);setContentView(content);
        try{long duration=getIntent().getLongExtra("duration",30000);if(duration!=30000&&duration!=900000)throw new IllegalArgumentException("Functional pilot30000 or approved900000ms");feed=new IngestionFeed(this,duration);chart=new AsterChartView(this,feed.engines[0]);content.addView(chart,new LinearLayout.LayoutParams(-1,0,1));chart.setDrawProbe(timing->{try{feed.probe.submitted(timing,chart.renderedRevision);}catch(Throwable error){feed.fail(error);}});getWindow().addOnFrameMetricsAvailableListener(frames,new Handler(Looper.getMainLooper()));feed.initialize();}catch(Throwable error){if(feed!=null)feed.fail(error);else{status.setText(error.toString());try{JSONObject failure=new JSONObject().put("passed",false).put("state","failed").put("error",error.toString()).put("stage","fixture-constructor-before-window");for(String file:new String[]{"progress.json","final.json"})try(java.io.FileOutputStream out=openFileOutput(file,0)){out.write(failure.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}}catch(Exception reportError){android.util.Log.e("AsterIngestion","Constructor report",reportError);}}}
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event){JSONObject row=null;long began=System.nanoTime();try{if(feed!=null&&chart!=null&&event.getRawY()>=chart.getTop())row=feed.probe.capture(event);}catch(Throwable error){feed.fail(error);}try{return super.dispatchTouchEvent(event);}finally{if(feed!=null)try{feed.probe.dispatch(row,began);}catch(Throwable error){feed.fail(error);}}}
    @Override protected void onResume(){super.onResume();if(feed!=null)feed.lifecycle("resume");}
    @Override protected void onPause(){if(feed!=null)feed.lifecycle("pause");super.onPause();}
    @Override protected void onStop(){if(feed!=null)feed.lifecycle("stop");super.onStop();}
    void removeFrameMetrics(){getWindow().removeOnFrameMetricsAvailableListener(frames);}
    @Override protected void onDestroy(){removeFrameMetrics();if(chart!=null)chart.setDrawProbe(null);if(feed!=null)feed.destroy();super.onDestroy();}
}
